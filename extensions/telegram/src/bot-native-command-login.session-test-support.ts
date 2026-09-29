import { vi } from "vitest";
import { resetNativeCommandMenuMocks } from "./bot-native-commands.menu-test-support.js";

const loginSessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
  patchSessionEntry: vi.fn(),
}));

vi.mock("./bot-native-commands.runtime.js", () => ({
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  getAgentScopedMediaLocalRoots: vi.fn(() => []),
  getSessionEntry: loginSessionMocks.getSessionEntry,
  resolveChunkMode: vi.fn(() => "length"),
  resolveThreadSessionKeys: vi.fn(
    ({
      baseSessionKey,
      parentSessionKey,
    }: {
      baseSessionKey: string;
      parentSessionKey?: string;
    }) => ({
      sessionKey: baseSessionKey,
      parentSessionKey,
    }),
  ),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntry: loginSessionMocks.getSessionEntry,
    resolveStorePath: loginSessionMocks.resolveStorePath,
    patchSessionEntry: loginSessionMocks.patchSessionEntry,
  };
});

export { loginSessionMocks };

export function resetLoginCommandMocks() {
  resetNativeCommandMenuMocks();
  loginSessionMocks.loadSessionStore.mockReset().mockReturnValue({});
  loginSessionMocks.getSessionEntry
    .mockReset()
    .mockImplementation(
      ({ storePath, sessionKey }: { storePath: string; sessionKey: string }) =>
        loginSessionMocks.loadSessionStore(storePath)[sessionKey],
    );
  loginSessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  loginSessionMocks.patchSessionEntry.mockReset().mockImplementation(async (params) => {
    const current = loginSessionMocks.loadSessionStore(params.storePath)[params.sessionKey];
    if (!current) {
      return null;
    }
    const patch = await params.update({ ...current });
    params.assertCommitAllowed?.();
    return patch ? { ...current, ...patch } : current;
  });
}
