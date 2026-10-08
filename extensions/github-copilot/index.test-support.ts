import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterAll, afterEach, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  })),
  resolveCopilotRuntimeAuth: vi.fn(),
  resolveCopilotStarterModel: vi.fn(async () => "github-copilot/claude-sonnet-5"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("./register.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./register.runtime.js")>("./register.runtime.js");
  return {
    ...actual,
    DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
    resolveCopilotRuntimeAuth: mocks.resolveCopilotRuntimeAuth,
    resolveCopilotStarterModel: mocks.resolveCopilotStarterModel,
    fetchCopilotUsage: vi.fn(),
  };
});

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.fetchWithSsrFGuard.mockImplementation(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  }));
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

export async function runDeviceAuthWithFakeTimers<T>(
  run: (openUrl: (url: string) => Promise<void>) => T | Promise<T>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    let notifyDeviceCodeShown!: () => void;
    const deviceCodeShown = new Promise<void>((resolve) => {
      notifyDeviceCodeShown = resolve;
    });
    const pending = Promise.resolve(run(async () => notifyDeviceCodeShown()));
    const openedBeforeCompletion = await Promise.race([
      deviceCodeShown.then(() => true),
      pending.then(() => false),
    ]);
    expect(openedBeforeCompletion).toBe(true);
    // Browser handoff follows the profile, device-code, and prompt work.
    await vi.advanceTimersByTimeAsync(1_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

export async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

export function createModelRegistry() {
  return {
    getAll: vi.fn(() => []),
    getAvailable: vi.fn(() => []),
    find: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => false),
  };
}

export function writeProfiles(
  agentDir: string,
  profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"],
) {
  saveAuthProfileStore({ version: 1, profiles }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

export function writeExistingCopilotTokenProfile(agentDir: string) {
  writeProfiles(agentDir, {
    "github-copilot:github": {
      type: "token",
      provider: "github-copilot",
      token: "existing-token",
    },
  });
}

export function nonInteractiveContext(agentDir: string) {
  return {
    authChoice: "github-copilot",
    config: {},
    baseConfig: {},
    opts: {},
    agentDir,
    toApiKeyCredential: vi.fn(),
  };
}

export function getIndexMocks() {
  return mocks;
}
