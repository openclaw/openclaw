import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { expect, it, vi } from "vitest";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createInboundSlackTestContext,
  createSlackTestAccount,
} from "./message-handler/prepare.test-helpers.js";

const importStarted = createDeferred<void>();
const importGate = createDeferred<void>();
const prepare = vi.fn();
const dispatch = vi.fn();

vi.mock("./message-handler/pipeline.runtime.js", async () => {
  importStarted.resolve();
  await importGate.promise;
  return { prepareSlackMessage: prepare, dispatchPreparedSlackMessage: dispatch };
});

it("releases the replay claim when cancellation interrupts the lazy pipeline import", async () => {
  const ctx = createInboundSlackTestContext({ cfg: { messages: { inbound: { debounceMs: 0 } } } });
  const controller = new AbortController();
  const guard = createChannelReplayGuard<{ keys: readonly string[] }>({
    dedupe: { ttlMs: 0, memoryMaxSize: 10 },
    buildReplayKey: (event) => event.keys,
  });
  const claim = {
    keys: ["import-gate"] as const,
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
  vi.spyOn(guard, "claim").mockResolvedValue({ kind: "claimed", handle: claim });
  const handler = createSlackMessageHandler({
    ctx,
    account: createSlackTestAccount(),
    abortSignal: controller.signal,
    dispatchReplayGuard: guard,
  });
  const handling = handler(
    { type: "message", channel: "D_TEST", user: "U_TEST", ts: "1709000000.005001", text: "hello" },
    { source: "message", awaitDispatch: true },
  );
  const rejected = expect(handling).rejects.toThrow("cancelled during pipeline import");
  try {
    await importStarted.promise;
    controller.abort(new Error("cancelled during pipeline import"));
    importGate.resolve();
    await rejected;
    expect(claim.release).toHaveBeenCalledOnce();
    expect(claim.commit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    importGate.resolve();
    controller.abort();
    await handling.catch(() => undefined);
    vi.restoreAllMocks();
  }
});
