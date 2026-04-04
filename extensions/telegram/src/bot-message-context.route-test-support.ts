import { vi, type Mock } from "vitest";

type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

const hoisted = vi.hoisted((): { recordInboundSessionMock: AsyncUnknownMock } => ({
  recordInboundSessionMock: vi.fn().mockResolvedValue(undefined),
}));

export const recordInboundSessionMock: AsyncUnknownMock = hoisted.recordInboundSessionMock;

vi.mock("./bot-message-context.session.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-message-context.session.runtime.js")>(
    "./bot-message-context.session.runtime.js",
  );
  return {
    ...actual,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
  };
});

export async function loadTelegramMessageContextRouteHarness() {
  vi.resetModules();
  const [
    { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot },
    { buildTelegramMessageContextForTest },
  ] = await Promise.all([
    import("../../../src/config/config.js"),
    import("./bot-message-context.test-harness.js"),
  ]);
  return {
    clearRuntimeConfigSnapshot,
    setRuntimeConfigSnapshot,
    buildTelegramMessageContextForTest,
  };
}

export function getRecordedUpdateLastRoute(callIndex = -1): unknown {
  const callArgs =
    callIndex === -1
      ? (recordInboundSessionMock.mock.calls.at(-1)?.[0] as
          | { updateLastRoute?: unknown }
          | undefined)
      : (recordInboundSessionMock.mock.calls[callIndex]?.[0] as
          | { updateLastRoute?: unknown }
          | undefined);
  return callArgs?.updateLastRoute;
}
