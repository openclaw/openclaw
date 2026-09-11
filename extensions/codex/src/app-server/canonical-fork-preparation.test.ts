// Codex tests cover the approval-policy guard on the canonical fork preparation path.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assertCodexNativeHookRelayAllowedMock = vi.fn(async () => {});
// The effective policy the fork guard keys on. `resolveCodexSupervisionAppServerRuntimeOptions`
// owns it in production (including forced prompting overrides); the tests pin it directly.
let effectiveApprovalPolicy: "never" | "on-request" = "never";

vi.mock("./native-hook-relay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-hook-relay.js")>()),
  assertCodexNativeHookRelayAllowed: (...args: unknown[]) =>
    assertCodexNativeHookRelayAllowedMock(...(args as [])),
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveCodexSupervisionAppServerRuntimeOptions: (
      params: Parameters<typeof actual.resolveCodexSupervisionAppServerRuntimeOptions>[0],
    ) => ({
      ...actual.resolveCodexSupervisionAppServerRuntimeOptions(params),
      approvalPolicy: effectiveApprovalPolicy,
    }),
  };
});

vi.mock("./native-execution-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-execution-policy.js")>()),
  resolveCodexNativeExecutionPolicy: () => ({
    nativeToolSurfaceAllowed: true,
    effectiveExecHost: "gateway",
  }),
}));

vi.mock("./native-skill-isolation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-skill-isolation.js")>()),
  resolveCodexNativeSkillIsolation: async () => undefined,
}));

vi.mock("./config-reviewer.js", () => ({
  assertCodexModelBackedReviewerEffectiveConfig: async () => {},
}));

vi.mock("./attempt-context.js", () => ({
  prepareCodexWorkspaceDeveloperInstructions: async () => "",
}));

vi.mock("./thread-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-prompt.js")>()),
  buildDeveloperInstructions: () => "developer instructions",
}));

vi.mock("./provider-capabilities.js", () => ({
  resolveCodexProviderWebSearchSupportForClient: async () => "unsupported",
}));

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", () => ({
  resolveCodexMcpToolOverridesForAgent: () => ({}),
  buildCodexUserMcpServersThreadConfigPatchForRuntime: async () => undefined,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  loadCodexBundleMcpThreadConfig: async () => ({
    diagnostics: [],
    configPatch: undefined,
    fingerprint: undefined,
  }),
}));

// A deterministic plan: every relay event has local work, so the config builder and
// the attestation gate are exercised by the guard's decision rather than by the
// ambient hook/loop-detection state of the test process.
vi.mock("openclaw/plugin-sdk/native-hook-relay-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/native-hook-relay-runtime")>()),
  buildNativeHookRelayCommandPlan: () => ({
    shouldRelayEvent: () => true,
    toolMatcherForEvent: () => undefined,
    commandForEvent: (event: string) => `openclaw-hook-relay --event ${event}`,
  }),
}));

const { prepareCanonicalCodexFork } = await import("./canonical-fork-preparation.js");

type PreparedFork = Awaited<ReturnType<typeof prepareCanonicalCodexFork>>;

function forkParams(pluginConfig: unknown) {
  const config = {} as OpenClawConfig;
  return {
    created: {
      agentId: "main",
      key: "agent:main:canonical-fork",
      sessionId: "session-canonical-fork",
      entry: { spawnedCwd: "/tmp/canonical-fork-workspace" },
    },
    initialization: {
      assertCurrent: () => {},
      prepareNativeToolPolicy: async () => ({ webSearchAllowed: false }),
    },
    config,
    context: {
      client: {
        request: async () => ({}),
        getRuntimeIdentity: () => undefined,
      },
      appServer: { start: {} },
      pluginConfig,
      agentDir: "/tmp/canonical-fork-agent",
    },
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    sandbox: undefined,
    dynamicTools: [],
  } as unknown as Parameters<typeof prepareCanonicalCodexFork>[0];
}

function optOutPluginConfig() {
  return {
    supervision: { enabled: true },
    appServer: {
      command: process.execPath,
      args: ["app-server"],
      nativeHookRelay: { enabled: false },
    },
  };
}

function threadConfigOf(prepared: PreparedFork): Record<string, unknown> {
  return (prepared.request as { config?: Record<string, unknown> }).config ?? {};
}

describe("prepareCanonicalCodexFork native hook relay kill-switch", () => {
  beforeEach(() => {
    assertCodexNativeHookRelayAllowedMock.mockClear();
    effectiveApprovalPolicy = "never";
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("honors the operator opt-out for a supervised fork when nothing needs the relay", async () => {
    const prepared = await prepareCanonicalCodexFork(forkParams(optOutPluginConfig()));

    const config = threadConfigOf(prepared);
    // No relay hook entries survive: the opt-out overlay clears all four arrays.
    expect(config["hooks.PreToolUse"]).toEqual([]);
    expect(config["hooks.PostToolUse"]).toEqual([]);
    expect(config["hooks.PermissionRequest"]).toEqual([]);
    expect(config["hooks.Stop"]).toEqual([]);
    // The overlay leaves the whole Codex hook engine alone; only the relay's own
    // session-layer commands are pinned disabled.
    expect(Object.hasOwn(config, "features.hooks")).toBe(false);
    expect(config["hooks.state"]).toEqual({
      "/<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
      "<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
      "/<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
      "<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
      "/<session-flags>/config.toml:permission_request:0:0": { enabled: false },
      "<session-flags>/config.toml:permission_request:0:0": { enabled: false },
      "/<session-flags>/config.toml:stop:0:0": { enabled: false },
      "<session-flags>/config.toml:stop:0:0": { enabled: false },
    });
    // Nothing is relayed, so managed-only hook attestation has nothing to attest.
    expect(assertCodexNativeHookRelayAllowedMock).not.toHaveBeenCalled();
  });

  it("narrows the opt-out to the before-tool policy relay while approvals prompt", async () => {
    effectiveApprovalPolicy = "on-request";

    const prepared = await prepareCanonicalCodexFork(forkParams(optOutPluginConfig()));

    const config = threadConfigOf(prepared);
    expect(config["features.hooks"]).toBe(true);
    const preToolUse = config["hooks.PreToolUse"] as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    expect(preToolUse?.[0]?.hooks?.[0]?.command).toContain("--event pre_tool_use");
    // The floor is exactly `pre_tool_use`; the remaining events stay cleared.
    expect(config["hooks.PostToolUse"]).toEqual([]);
    expect(config["hooks.PermissionRequest"]).toEqual([]);
    expect(config["hooks.Stop"]).toEqual([]);
    // The narrowing installs an enforcing relay, so attestation must stay armed.
    expect(assertCodexNativeHookRelayAllowedMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the relay for a fork whose host still runs a before-tool policy under never", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );

    const prepared = await prepareCanonicalCodexFork(forkParams(optOutPluginConfig()));

    const config = threadConfigOf(prepared);
    expect(config["features.hooks"]).toBe(true);
    const preToolUse = config["hooks.PreToolUse"] as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    expect(preToolUse?.[0]?.hooks?.[0]?.command).toContain("--event pre_tool_use");
    expect(assertCodexNativeHookRelayAllowedMock).toHaveBeenCalledTimes(1);
  });

  it("installs the full relay when no opt-out is configured", async () => {
    const prepared = await prepareCanonicalCodexFork(
      forkParams({
        supervision: { enabled: true },
        appServer: { command: process.execPath, args: ["app-server"] },
      }),
    );

    const config = threadConfigOf(prepared);
    expect(config["features.hooks"]).toBe(true);
    expect(config["hooks.PreToolUse"]).not.toEqual([]);
    expect(config["hooks.PostToolUse"]).not.toEqual([]);
    expect(assertCodexNativeHookRelayAllowedMock).toHaveBeenCalledTimes(1);
  });
});
