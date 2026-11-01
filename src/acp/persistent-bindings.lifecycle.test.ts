/** Tests configured ACP binding lifecycle behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AcpSessionResolution } from "./control-plane/manager.types.js";
import {
  buildConfiguredAcpSessionKey,
  type ConfiguredAcpBindingSpec,
} from "./persistent-bindings.types.js";

const managerMocks = vi.hoisted(() => ({
  resolveSessionAsync: vi.fn<(params: { sessionKey: string }) => Promise<AcpSessionResolution>>(),
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

// mock-isolation: lifecycle assertions must not create real ACP sessions or workers.
vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => managerMocks,
}));

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: { entries: { codex: {}, claude: {} } },
} satisfies OpenClawConfig;

let ensureConfiguredAcpBindingSession: typeof import("./persistent-bindings.lifecycle.js").ensureConfiguredAcpBindingSession;

beforeEach(async () => {
  vi.resetModules();
  managerMocks.resolveSessionAsync.mockReset();
  managerMocks.closeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.setSessionConfigOption.mockReset().mockResolvedValue(undefined);
  ({ ensureConfiguredAcpBindingSession } = await import("./persistent-bindings.lifecycle.js"));
});

function createPersistentSpec(
  overrides: Partial<ConfiguredAcpBindingSpec> = {},
): ConfiguredAcpBindingSpec {
  return {
    channel: "discord",
    accountId: "default",
    conversationId: "1478836151241412759",
    agentId: "codex",
    mode: "persistent",
    ...overrides,
  };
}

function mockReadySession(params: {
  spec: ConfiguredAcpBindingSpec;
  cwd: string;
  model?: string;
  thinking?: string;
  state?: "idle" | "running" | "error";
}) {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  managerMocks.resolveSessionAsync.mockResolvedValue({
    kind: "ready",
    sessionKey,
    agentId: params.spec.agentId,
    meta: {
      backend: "acpx",
      agent: params.spec.acpAgentId ?? params.spec.agentId,
      runtimeSessionName: "existing",
      mode: params.spec.mode,
      runtimeOptions: {
        cwd: params.cwd,
        ...(params.model ? { model: params.model } : {}),
        ...(params.thinking ? { thinking: params.thinking } : {}),
      },
      state: params.state ?? "idle",
      lastActivityAt: Date.now(),
    },
  });
  return sessionKey;
}

function expectNotReplaced() {
  expect(managerMocks.closeSession).not.toHaveBeenCalled();
  expect(managerMocks.initializeSession).not.toHaveBeenCalled();
}

const ensure = (spec: ConfiguredAcpBindingSpec) =>
  ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec });

describe("ensureConfiguredAcpBindingSession", () => {
  it("updates configured runtime options in place", async () => {
    const runtimeOptions = { model: "anthropic/claude-sonnet-4-6", thinking: "off" };
    const spec = createPersistentSpec(runtimeOptions);
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
      model: "anthropic/claude-haiku-4-5",
      thinking: "high",
    });
    expect(await ensure(spec)).toEqual({ ok: true, sessionKey });
    expect(managerMocks.setSessionConfigOption.mock.calls).toEqual(
      Object.entries(runtimeOptions).map(([key, value]) => [
        { cfg: baseCfg, sessionKey, agentId: spec.agentId, key, value },
      ]),
    );
    expectNotReplaced();
  });

  it("reports rejected live thinking without replacing or overwriting the existing session", async () => {
    const spec = createPersistentSpec({ thinking: "off" });
    const sessionKey = mockReadySession({ spec, cwd: "/workspace/openclaw", thinking: "high" });
    managerMocks.setSessionConfigOption.mockRejectedValue(new Error("Live off is unsupported"));

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await ensure(spec)).toEqual({
        ok: false,
        sessionKey,
        error: "Live off is unsupported",
      });
    }
    expect(managerMocks.setSessionConfigOption).toHaveBeenCalledTimes(2);
    expectNotReplaced();
  });

  it("reinitializes a ready session when binding config explicitly sets mismatched cwd", async () => {
    const spec = createPersistentSpec({
      cwd: "/workspace/repo-a",
      agentId: "coding",
      acpAgentId: "codex",
      model: "anthropic/claude-sonnet-4-6",
      thinking: "off",
    });
    const sessionKey = mockReadySession({ spec, cwd: "/workspace/other-repo" });
    expect(await ensure(spec)).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey, clearMeta: false }),
    );
    expect(managerMocks.initializeSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent: "codex",
        runtimeOptions: { model: "anthropic/claude-sonnet-4-6", thinking: "off" },
      }),
    );
    expect(managerMocks.initializeSession.mock.calls[0]?.[0]).not.toHaveProperty("modelExplicit");
  });

  it("reinitializes a matching session when the stored ACP session is in error state", async () => {
    const spec = createPersistentSpec({ cwd: "/home/bob/clawd" });
    const sessionKey = mockReadySession({ spec, cwd: "/home/bob/clawd", state: "error" });
    expect(await ensure(spec)).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).toHaveBeenCalledTimes(1);
    expect(managerMocks.initializeSession).toHaveBeenCalledTimes(1);
  });
});
