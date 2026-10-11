import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

type InboundDebounceFlush = { admission: Promise<void>; completion: Promise<void> };
const enqueueMock = vi.fn(async (_entry: unknown) => {});
const onFlushCallbacks: Array<
  (
    entries: Array<Record<string, unknown>>,
    createFlush: typeof createTestInboundDebounceFlush,
  ) => InboundDebounceFlush
> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async () => {});
const { createSlackMessageHandler } = await import("./message-handler.js");

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (
      params: Parameters<typeof actual.createChannelInboundDebouncer<Record<string, unknown>>>[0],
    ) => {
      onFlushCallbacks.push(params.onFlush);
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        },
      };
    },
    shouldDebounceTextInbound: () => true,
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }: { message: Record<string, unknown> }) => message,
  }),
}));
vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

function runOnFlush(entries: Array<Record<string, unknown>>): Promise<void> {
  return onFlushCallbacks[0]!(entries, createTestInboundDebounceFlush).completion;
}

function createContext() {
  const ctx = {
    cfg: {},
    accountId: "default",
    app: { client: {} },
    runtime: {},
    rememberSlackChannelType: () => {},
  } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
  ctx.readRuntimeContext = async () => ctx;
  ctx.isRuntimePolicyCurrent = () => true;
  return ctx;
}

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
  onFlushCallbacks.length = 0;
});

describe("Slack duplicate wait admission", () => {
  it("releases a deferred turn's replay claim before forwarding cancellation", async () => {
    const handle = {
      keys: ["cancelled"] as const,
      commit: vi.fn(async () => true),
      release: vi.fn(),
    };
    const turnAdoptionLifecycle = {
      admission: "exclusive" as const,
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onCancelled: vi.fn(async () => {}),
      onAbandoned: vi.fn(),
    };
    let prepared:
      | { turnAdoptionLifecycle?: { onDeferred: () => void; onCancelled?: () => Promise<void> } }
      | undefined;
    dispatchPreparedSlackMessageMock.mockImplementationOnce(async (value?: unknown) => {
      prepared = value as typeof prepared;
      prepared?.turnAdoptionLifecycle?.onDeferred();
    });
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      dispatchReplayGuard: {
        claim: async () => ({ kind: "claimed", handle }),
      } as unknown as NonNullable<
        Parameters<typeof createSlackMessageHandler>[0]["dispatchReplayGuard"]
      >,
    });
    await handler(
      { type: "message", channel: "C_TEST", user: "U_TEST", ts: "1709000000.008001" } as never,
      { source: "message", turnAdoptionLifecycle },
    );
    await runOnFlush(enqueueMock.mock.calls.map(([entry]) => entry).filter(isRecord));
    expect(handle.release).not.toHaveBeenCalled();

    // The reply lane cancels the queued turn before it is admitted.
    await prepared?.turnAdoptionLifecycle?.onCancelled?.();

    expect(handle.release).toHaveBeenCalledOnce();
    expect(handle.commit).not.toHaveBeenCalled();
    expect(turnAdoptionLifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(turnAdoptionLifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(handle.release.mock.invocationCallOrder[0]).toBeLessThan(
      turnAdoptionLifecycle.onCancelled.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
