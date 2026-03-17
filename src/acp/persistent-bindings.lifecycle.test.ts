import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";
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

vi.mock("../channels/plugins/acp-bindings.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));
type AcpBindingSessionsModule = typeof import("../channels/plugins/acp-binding-sessions.js");
let acpBindingSessions: AcpBindingSessionsModule;
let acpBindingSessionsImportScope = 0;

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

beforeEach(async () => {
  vi.resetModules();
  acpBindingSessionsImportScope += 1;
  acpBindingSessions = await importFreshModule<AcpBindingSessionsModule>(
    import.meta.url,
    `../channels/plugins/acp-binding-sessions.js?scope=${acpBindingSessionsImportScope}`,
  );
  managerMocks.closeSession.mockReset().mockResolvedValue({
    runtimeClosed: true,
    metaCleared: false,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.updateSessionRuntimeOptions.mockReset().mockResolvedValue(undefined);
  sessionMetaMocks.readAcpSessionEntry.mockReset().mockReturnValue(undefined);
  resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReset().mockReturnValue(null);
});

describe("resetConfiguredAcpBindingSessionInPlace", () => {
  it("does not resolve configured bindings when ACP metadata already exists", async () => {
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
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

    const result = await acpBindingSessions.resetConfiguredAcpBindingSessionInPlace({
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
});
