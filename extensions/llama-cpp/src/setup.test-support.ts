import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  prepareServer: vi.fn(),
  removeProfiles: vi.fn(),
  progressUpdate: vi.fn(),
  hardware: vi.fn(),
  downloadFetch: vi.fn(),
  ensureServerInstalled: vi.fn(),
}));
export { mocks };

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  removeProviderAuthProfilesWithLock: mocks.removeProfiles,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.downloadFetch,
}));

vi.mock("./managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepareServer,
}));

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: mocks.ensureServerInstalled,
}));

vi.mock("./hardware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hardware.js")>()),
  detectLlamaCppHardware: mocks.hardware,
}));

import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";
import { resolveLlamaCppCatalogArtifact } from "./model-catalog.js";

export const GIB = 1024 ** 3;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
export let tempRoot: string;
export let modelPath: string;

beforeEach(async () => {
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GIB);
  vi.spyOn(os, "hostname").mockReturnValue("gateway-host");
  mocks.hardware.mockReset().mockImplementation(async () => ({
    platform: "darwin",
    arch: "arm64",
    accelerator: { kind: "metal" },
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: os.totalmem(),
    availableDiskBytes: 100 * GIB,
    availableRuntimeDiskBytes: 100 * GIB,
    sharedDisk: true,
  }));
  tempRoot = await fs.realpath(tempDirs.make("llama-server-setup-"));
  modelPath = path.join(tempRoot, "model.gguf");
  mocks.ensureModel.mockReset().mockImplementation(async ({ source, download }) => {
    if (!download) {
      throw new Error("not cached");
    }
    return resolveLlamaCppCatalogArtifact(source)
      ? modelPath
      : path.join(tempRoot, "embedding.gguf");
  });
  mocks.prepareServer.mockReset().mockResolvedValue({
    command: path.join(tempRoot, "llama-server"),
    baseUrl: "http://127.0.0.1:19432/v1",
    healthUrl: "http://127.0.0.1:19432/health",
    args: ["--host", "127.0.0.1", "--port", "19432"],
  });
  mocks.removeProfiles.mockReset().mockResolvedValue({ version: 1, profiles: {} });
  mocks.progressUpdate.mockReset();
  mocks.downloadFetch.mockReset();
  mocks.ensureServerInstalled.mockReset().mockImplementation(async ({ asset }) => ({
    command: path.join(tempRoot, "llama-server"),
    asset,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

export function config(): ProviderAppGuidedSetupContext["config"] {
  return {
    models: {
      providers: {
        [LLAMA_CPP_PROVIDER_ID]: {
          baseUrl: "http://127.0.0.1:19432/v1",
          api: "openai-completions",
          params: { modelCacheDir: tempRoot },
          models: [],
        },
      },
    },
  };
}

export function authContext(confirm: boolean): ProviderAuthContext {
  return {
    config: config(),
    prompter: {
      confirm: vi.fn(async () => confirm),
      note: vi.fn(async () => {}),
      progress: vi.fn(() => ({ update: mocks.progressUpdate, stop: vi.fn() })),
    },
    runtime: {},
  } as unknown as ProviderAuthContext;
}
