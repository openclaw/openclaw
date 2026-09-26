import fs from "node:fs/promises";
import path from "node:path";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: vi.fn<() => string>(),
  install: vi.fn(),
  genericCreate: vi.fn(),
}));

vi.mock("./defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./defaults.js")>()),
  resolveLlamaCppDataDir: mocks.dataDir,
}));
vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: mocks.install,
}));
vi.mock("openclaw/plugin-sdk/embedding-providers", () => ({
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));

import { llamaCppEmbeddingProviderAdapter } from "./embedding-provider.js";
import {
  findManagedLlamaServerAsset,
  LLAMA_SERVER_RELEASE,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
} from "./llama-server-assets.js";
import { ensureManagedLlamaServerForChat } from "./managed-server.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function createFixture() {
  const root = tempDirs.make("llama-managed-recovery-");
  mocks.dataDir.mockReturnValue(path.join(root, "tools", "llama.cpp"));
  const asset = selectLlamaServerAsset();
  const { command, presetPath } = resolveManagedLlamaServerPaths(asset);
  const modelPath = path.join(root, "chat.gguf");
  await fs.writeFile(modelPath, "GGUF");
  mocks.install.mockImplementation(async () => {
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "restored managed executable");
    return { command, asset };
  });
  const model = {
    id: "chat",
    name: "Chat",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    params: { modelPath },
  } satisfies ModelDefinitionConfig;
  const provider = {
    baseUrl: "http://127.0.0.1:19432/v1",
    localService: { command, args: ["--models-preset", presetPath] },
    params: { modelCacheDir: root },
    models: [model],
  };
  return { root, asset, command, presetPath, modelPath, model, provider };
}

describe("managed llama-server recovery", () => {
  it("restores a missing configured managed executable before preparing chat", async () => {
    const { asset, command, presetPath, model, provider } = await createFixture();
    await ensureManagedLlamaServerForChat({ model, provider });

    expect(mocks.install).toHaveBeenCalledExactlyOnceWith({
      asset,
      signal: undefined,
      onProgress: undefined,
    });
    expect(await fs.readFile(command, "utf8")).toBe("restored managed executable");
    expect(await fs.readFile(presetPath, "utf8")).toContain("[chat]");
    expect(provider.localService.command).toBe(command);
  });

  it("restores the managed executable before creating the embedding transport", async () => {
    const { asset, command, modelPath, provider } = await createFixture();
    mocks.genericCreate.mockImplementation(async () => {
      expect(await fs.readFile(command, "utf8")).toBe("restored managed executable");
      return { provider: null };
    });

    await llamaCppEmbeddingProviderAdapter.create({
      config: { models: { providers: { "llama-cpp": { ...provider, models: [] } } } },
      provider: "local",
      model: modelPath,
      local: { modelPath },
    });

    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ asset }));
    expect(mocks.genericCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing managed executable without reinstalling it", async () => {
    const { command, model, provider } = await createFixture();
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "existing executable");

    await ensureManagedLlamaServerForChat({ model, provider });

    expect(mocks.install).not.toHaveBeenCalled();
    expect(await fs.readFile(command, "utf8")).toBe("existing executable");
  });

  it.each(["custom", "older release", "another state directory"])(
    "does not replace a missing executable from %s",
    async (kind) => {
      const { root, command, model, provider } = await createFixture();
      const configuredCommand =
        kind === "custom"
          ? path.join(root, "custom", "llama-server")
          : kind === "older release"
            ? command.replace(LLAMA_SERVER_RELEASE, "b1")
            : command.replace(root, path.join(root, "other"));
      provider.localService.command = configuredCommand;

      await ensureManagedLlamaServerForChat({ model, provider });

      expect(mocks.install).not.toHaveBeenCalled();
      expect(provider.localService.command).toBe(configuredCommand);
    },
  );

  it("propagates installation failures without changing the configured command", async () => {
    const { command, model, provider } = await createFixture();
    mocks.install.mockRejectedValue(new Error("archive verification failed"));

    await expect(ensureManagedLlamaServerForChat({ model, provider })).rejects.toThrow(
      "archive verification failed",
    );
    expect(provider.localService.command).toBe(command);
  });

  it.each(["EACCES", "ENOTDIR"])("does not reinstall after a %s filesystem error", async (code) => {
    const { command, model, provider } = await createFixture();
    const stat = fs.stat;
    const error = Object.assign(new Error("cannot inspect executable"), { code });
    vi.spyOn(fs, "stat").mockImplementation((...args) => {
      if (args[0] === command) {
        return Promise.reject(error);
      }
      return stat(...args);
    });

    await expect(ensureManagedLlamaServerForChat({ model, provider })).rejects.toBe(error);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("recognizes the configured Windows backend and rejects another host", async () => {
    await createFixture();
    const cpu = selectLlamaServerAsset("win32", "x64");
    const cuda = selectLlamaServerAsset("win32", "x64", {
      kind: "cuda",
      devices: [{ driverVersion: "580.1", computeCapability: 8.6 }],
    });
    for (const asset of [cpu, cuda]) {
      const { command } = resolveManagedLlamaServerPaths(asset);
      expect(findManagedLlamaServerAsset(command, "win32", "x64")).toBe(asset);
      expect(findManagedLlamaServerAsset(command, "linux", "x64")).toBeUndefined();
      expect(findManagedLlamaServerAsset(command, "win32", "arm64")).toBeUndefined();
    }
  });
});
