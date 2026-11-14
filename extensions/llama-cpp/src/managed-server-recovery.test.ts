import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

const mocks = vi.hoisted(() => ({
  dataDir: vi.fn<() => string>(),
  resourceStateDir: vi.fn<() => string>(),
  install: vi.fn(),
  genericCreate: vi.fn(),
  reap: vi.fn(),
}));

// mock-isolation: Core owns inherited resource roots; exercise their SDK contract at this boundary.
vi.mock("openclaw/plugin-sdk/state-paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/state-paths")>()),
  resolveManagedResourceStateDir: mocks.resourceStateDir,
}));

vi.mock("./defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./defaults.js")>()),
  resolveLlamaCppDataDir: mocks.dataDir,
}));
vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: mocks.install,
}));
// mock-isolation: Exercise preparation without initializing the shared provider registry.
vi.mock("openclaw/plugin-sdk/embedding-providers", () => ({
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));
// mock-isolation: Plugin preparation selects recovery policy; native process custody has owner tests.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  reapOrphanedProcesses: mocks.reap,
}));

import { llamaCppEmbeddingProviderAdapter } from "./embedding-provider.js";
import {
  LLAMA_SERVER_RELEASE,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
} from "./llama-server-assets.js";
import { ensureManagedLlamaServerForChat } from "./managed-server.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function createFixture() {
  const root = tempDirs.make("llama-managed-recovery-");
  mocks.dataDir.mockReturnValue(path.join(root, "tools", "llama.cpp"));
  mocks.reap.mockResolvedValue([]);
  const asset = selectLlamaServerAsset();
  const { command, presetPath } = resolveManagedLlamaServerPaths(asset);
  const modelPath = path.join(root, "chat.gguf");
  await fs.writeFile(modelPath, "GGUF");
  mocks.install.mockImplementation(async () => {
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "restored managed executable");
    return { command, asset };
  });
  const provider = {
    baseUrl: "http://127.0.0.1:19432/v1",
    localService: {
      command,
      args: [..."--host 127.0.0.1 --port 19432 --models-preset".split(" "), presetPath],
    },
    params: { modelCacheDir: root },
    models: [],
  };
  const prepare = () =>
    ensureManagedLlamaServerForChat({
      model: { id: "chat", maxTokens: 2048, params: { modelPath } },
      provider,
    });
  const embed = (localService = provider.localService) =>
    llamaCppEmbeddingProviderAdapter.create({
      config: { models: { providers: { "llama-cpp": { ...provider, localService } } } },
      provider: "local",
      model: modelPath,
      local: { modelPath },
    });
  return { root, command, presetPath, modelPath, provider, prepare, embed };
}

it.each([
  ["missing host", (args: string[]) => args.splice(0, 2)],
  ["duplicate preset", (args: string[]) => args.push("--models-preset", "other.ini")],
  ["different port", (args: string[]) => args.splice(3, 1, "19433")],
  ["direct model", (args: string[]) => args.splice(4, 2, "--model", "chat.gguf")],
] as const)("leaves routers untouched for a configuration with %s", async (_kind, changeArgs) => {
  const { prepare, provider } = await createFixture();
  changeArgs(provider.localService.args);
  await prepare();
  expect(mocks.reap).not.toHaveBeenCalled();
});

it.each(["absolute", "relative", "equals"])("recovers %s before transport", async (kind) => {
  const { root, command, presetPath, provider, embed } = await createFixture();
  const preset = kind === "relative" ? "models.ini" : presetPath;
  const localService = {
    ...provider.localService,
    ...(kind === "relative" ? { cwd: root } : {}),
    args: [
      ...provider.localService.args.slice(0, 4),
      ...(kind === "equals" ? [`--models-preset=${preset}`] : ["--models-preset", preset]),
    ],
  };
  let orphanAlive = true;
  mocks.reap.mockImplementation(async ({ command: executable, matchesArguments, cwd }) => {
    expect(executable).toBe(command);
    const matches = (...args: string[]) =>
      matchesArguments([command, "--host", "127.0.0.1", ...args]);
    expect(matches("--port", "19432", "--models-preset", preset)).toBe(true);
    expect(cwd).toBe(kind === "relative" ? root : undefined);
    expect(matches("--port", "19433", "--models-preset", preset)).toBe(false);
    expect(matches("--port", "19432", "--models-preset", `${preset}.other`)).toBe(false);
    expect(matches("--port", "19432", "--port", "19433", "--models-preset", preset)).toBe(false);
    orphanAlive = false;
    return [1234];
  });
  mocks.genericCreate.mockImplementation(async () => {
    expect(orphanAlive).toBe(false);
    expect(await fs.readFile(command, "utf8")).toBe("restored managed executable");
    return { provider: null };
  });
  await embed(localService);
  await embed(localService);
  expect(mocks.reap).toHaveBeenCalledOnce();
});

it.each([false, true])("prepares chat with an existing executable: %s", async (existing) => {
  const { command, presetPath, prepare } = await createFixture();
  if (existing) {
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "existing executable");
  }
  await prepare();
  expect(await fs.readFile(command, "utf8")).toBe(
    existing ? "existing executable" : "restored managed executable",
  );
  expect(await fs.readFile(presetPath, "utf8")).toContain("[chat]");
  await prepare();
  expect(mocks.install).toHaveBeenCalledTimes(existing ? 0 : 1);
});

it("reports the missing OpenSSL runtime through embedding errors and status facts", async () => {
  const { embed, provider } = await createFixture();
  const server = http.createServer((_request, response) => {
    response.writeHead(503).end();
  });
  const port = await listenOnLoopback(server);
  try {
    provider.baseUrl = `http://127.0.0.1:${port}/v1`;
    const detail =
      "llama-server: error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory";
    mocks.genericCreate.mockResolvedValue({
      provider: {
        id: "llama-cpp",
        model: "fixture",
        embed: async () => {
          throw new Error(detail);
        },
      },
    });
    const result = await embed();
    await expect(result.provider?.embed("test")).rejects.toThrow("Install the OpenSSL 3");
    const facts = Reflect.get(
      result.provider!,
      Symbol.for("openclaw.localEmbeddingRuntimeFacts"),
    )();
    expect(facts).toMatchObject({
      state: "failed",
      loadError: expect.stringContaining("libssl.so.3"),
    });
    expect(facts.loadError).toContain("libssl3t64");
    expect(facts.loadError).toContain(detail);
    expect(facts.loadError).not.toContain("OpenMP");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it.each(["custom", "older release", "another state directory"])("ignores %s", async (kind) => {
  const { root, command, prepare, provider } = await createFixture();
  const configuredCommand =
    kind === "custom"
      ? path.join(root, "custom", "llama-server")
      : kind === "older release"
        ? command.replace(LLAMA_SERVER_RELEASE, "b1")
        : command.replace(root, path.join(root, "other"));
  provider.localService.command = configuredCommand;
  await prepare();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(provider.localService.command).toBe(configuredCommand);
  expect(mocks.reap).not.toHaveBeenCalled();
});

it.each(["installation", "EACCES", "ENOTDIR"])("propagates %s", async (code) => {
  const { command, prepare, provider } = await createFixture();
  const stat = fs.stat;
  const message =
    code === "installation" ? "archive verification failed" : "cannot inspect executable";
  const error = Object.assign(new Error(message), { code });
  if (code === "installation") {
    mocks.install.mockRejectedValue(error);
  } else {
    vi.spyOn(fs, "stat").mockImplementation((...args) =>
      args[0] === command ? Promise.reject(error) : stat(...args),
    );
  }
  await expect(prepare()).rejects.toBe(error);
  expect(mocks.install).toHaveBeenCalledTimes(code === "installation" ? 1 : 0);
  expect(provider.localService.command).toBe(command);
});

it.each(["embedding", "chat"])(
  "keeps shared %s models usable after temporary state cleanup",
  async (kind) => {
    const operator = tempDirs.make("llama-operator-");
    const temporary = tempDirs.make("llama-temporary-");
    vi.stubEnv("OPENCLAW_STATE_DIR", operator);
    mocks.resourceStateDir.mockReturnValue(operator);
    const defaults = await vi.importActual<typeof import("./defaults.js")>("./defaults.js");
    mocks.dataDir.mockImplementation(defaults.resolveLlamaCppDataDir);
    mocks.reap.mockResolvedValue([]);
    const { command, presetPath } = resolveManagedLlamaServerPaths(selectLlamaServerAsset());
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "managed executable");
    const cache = path.join(operator, "models", "llama.cpp");
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, "chat.gguf"), "GGUF");
    await fs.writeFile(path.join(cache, "embedding.gguf"), "GGUF");
    const provider = {
      baseUrl: "http://127.0.0.1:19432/v1",
      localService: {
        command,
        args: ["--host", "127.0.0.1", "--port", "19432", "--models-preset", presetPath],
      },
      models: [],
    };
    mocks.genericCreate.mockResolvedValue({ provider: null });
    vi.stubEnv("OPENCLAW_STATE_DIR", temporary);
    if (kind === "chat") {
      await ensureManagedLlamaServerForChat({
        provider,
        model: { id: "chat", params: { modelPath: "chat.gguf" } },
      });
    } else {
      await llamaCppEmbeddingProviderAdapter.create({
        config: { models: { providers: { "llama-cpp": provider } } },
        provider: "local",
        model: "embedding.gguf",
        local: { modelPath: "embedding.gguf" },
      });
    }
    await fs.rm(temporary, { recursive: true, force: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", operator);
    const preset = await fs.readFile(presetPath, "utf8");
    expect(preset).not.toContain(temporary);
    expect(preset).toContain(path.join(cache, kind === "chat" ? "chat.gguf" : "embedding.gguf"));
    if (kind === "embedding") {
      await llamaCppEmbeddingProviderAdapter.create({
        config: { models: { providers: { "llama-cpp": provider } } },
        provider: "local",
        model: "embedding.gguf",
        local: { modelPath: "embedding.gguf" },
      });
      expect(mocks.genericCreate).toHaveBeenCalledTimes(2);
    }
  },
);
