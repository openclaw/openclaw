import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSrtSandboxBackendFactory, shutdownSrtSandboxRuntime } from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

const native = vi.hoisted(() => ({
  install: vi.fn().mockRejectedValue(new Error("unexpected native mutation")),
  grant: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    installWindowsSandboxAsync: native.install,
    grantWindowsAcl: native.grant,
    revokeWindowsAcl: native.revoke,
  };
});
beforeEach(() => {
  native.install.mockClear();
  native.grant.mockClear();
  native.revoke.mockClear();
});

vi.mock("./dependency-probe.js", async (importActual) => ({
  ...(await importActual<typeof import("./dependency-probe.js")>()),
  assertSrtSandboxAvailable: vi.fn().mockResolvedValue(undefined),
}));

afterEach(async () => {
  await shutdownSrtSandboxRuntime();
  vi.restoreAllMocks();
});

it("admits repeated concurrent turns for the same Windows runtime without admitting another scope", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const factory = createSrtSandboxBackendFactory({
    pluginConfig: resolveSrtPluginConfig(undefined),
  });
  const params: CreateSandboxBackendParams = {
    sessionKey: "turn-1",
    scopeKey: "scope-1",
    runtimeId: "runtime-1",
    assertRuntimeCurrent: () => {},
    workspaceDir: "C:\\sandbox\\private",
    agentWorkspaceDir: "C:\\agent",
    cfg: {
      mode: "all",
      backend: "srt",
      scope: "session",
      workspaceAccess: "none",
      workspaceRoot: "C:\\sandbox",
      dockerTmpfsSource: "default",
      docker: { workdir: "C:\\sandbox\\private", env: {} },
      ssh: {},
      browser: {},
      tools: {},
      prune: {},
    } as unknown as CreateSandboxBackendParams["cfg"],
  };
  const results = await Promise.allSettled([
    factory(params),
    factory({ ...params, sessionKey: "turn-2" }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  await expect(
    factory({ ...params, scopeKey: "other-scope", runtimeId: "runtime-2" }),
  ).rejects.toThrow();
});

it.each([
  { network: "deny" },
  { network: "allow" },
  { network: "deny", allowedDomains: ["example.com"] },
  { network: "deny", perSessionNetwork: true },
  { network: "deny", perSessionNetwork: true, parentProxy: { http: "http://127.0.0.1:8080" } },
  { network: "allow", allowedDomains: ["example.com"], perSessionNetwork: true },
])(
  "rejects Windows network policy %j before persistent mutation, including after retirement",
  async (rawConfig) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(rawConfig),
    });
    const params = {
      sessionKey: "network",
      scopeKey: "network",
      workspaceDir: "C:\\sandbox",
      agentWorkspaceDir: "C:\\agent",
      cfg: {
        mode: "all",
        backend: "srt",
        scope: "session",
        workspaceAccess: "none",
        workspaceRoot: "C:\\sandbox",
        dockerTmpfsSource: "default",
        docker: { workdir: "C:\\sandbox", env: {} },
        ssh: {},
        browser: {},
        tools: {},
        prune: {},
      },
    } as CreateSandboxBackendParams;
    const handle = await factory(params);
    await expect(handle.runShellCommand({ script: "echo blocked" })).rejects.toThrow(
      "Windows execution is unavailable",
    );
    await expect(
      handle.buildExecSpec({ command: "echo blocked", env: {}, usePty: false }),
    ).rejects.toThrow("Windows execution is unavailable");
    expect(() => handle.prepareProcessCleanup!({})).toThrow("Windows execution is unavailable");
    await shutdownSrtSandboxRuntime();
    await expect(handle.runShellCommand({ script: "echo stale" })).rejects.toThrow("torn down");
    expect(native.install).not.toHaveBeenCalled();
    expect(native.grant).not.toHaveBeenCalled();
    expect(native.revoke).not.toHaveBeenCalled();
  },
);
