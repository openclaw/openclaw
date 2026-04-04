import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const managerMocks = vi.hoisted(() => ({
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  updateSessionRuntimeOptions: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn(),
}));

const resolveMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  unbind: vi.fn(),
}));

vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    closeSession: managerMocks.closeSession,
    initializeSession: managerMocks.initializeSession,
    updateSessionRuntimeOptions: managerMocks.updateSessionRuntimeOptions,
  }),
}));

vi.mock("./runtime/session-meta.js", () => ({
  readAcpSessionEntry: sessionMetaMocks.readAcpSessionEntry,
}));

vi.mock("./persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));

vi.mock("../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    unbind: (input: unknown) => bindingServiceMocks.unbind(input),
  }),
}));
const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

let resetAcpSessionInPlace: typeof import("./persistent-bindings.lifecycle.js").resetAcpSessionInPlace;

beforeAll(async () => {
  ({ resetAcpSessionInPlace } = await import("./persistent-bindings.lifecycle.js"));
});

beforeEach(() => {
  managerMocks.closeSession.mockReset().mockResolvedValue({
    runtimeClosed: true,
    metaCleared: false,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.updateSessionRuntimeOptions.mockReset().mockResolvedValue(undefined);
  sessionMetaMocks.readAcpSessionEntry.mockReset().mockReturnValue(undefined);
  resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReset().mockReturnValue(null);
  bindingServiceMocks.unbind.mockReset().mockResolvedValue([]);
});

describe("resetAcpSessionInPlace", () => {
  it("does not resolve configured bindings when ACP metadata already exists", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
        runtimeOptions: { cwd: "/home/bob/clawd" },
      },
    });
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockImplementation(() => {
      throw new Error("configured binding resolution should be skipped");
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "reset",
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).not.toHaveBeenCalled();
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        clearMeta: false,
      }),
    );
    expect(managerMocks.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        agent: "claude",
        backendId: "acpx",
      }),
    );
  });

  it("unbinds stale bindings and returns skipped when the ACP cwd is gone", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:stale";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
        runtimeOptions: { cwd: "/tmp/opik-runtime-pr2" },
      },
    });
    managerMocks.initializeSession.mockRejectedValueOnce(
      new Error("ACP runtime working directory does not exist: /tmp/opik-runtime-pr2"),
    );

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "new",
    });

    expect(result).toEqual({
      ok: false,
      skipped: true,
      error: "ACP runtime working directory does not exist: /tmp/opik-runtime-pr2",
    });
    expect(bindingServiceMocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: sessionKey,
      reason: "acp-session-init-failed",
    });
  });

  it("still returns skipped when stale-binding cleanup fails", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:stale";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
        runtimeOptions: { cwd: "/tmp/opik-runtime-pr2" },
      },
    });
    managerMocks.initializeSession.mockRejectedValueOnce(
      new Error("ACP runtime working directory does not exist: /tmp/opik-runtime-pr2"),
    );
    bindingServiceMocks.unbind.mockRejectedValueOnce(new Error("unbind failed"));

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "new",
    });

    expect(result).toEqual({
      ok: false,
      skipped: true,
      error: "ACP runtime working directory does not exist: /tmp/opik-runtime-pr2",
    });
    expect(bindingServiceMocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: sessionKey,
      reason: "acp-session-init-failed",
    });
  });
});
