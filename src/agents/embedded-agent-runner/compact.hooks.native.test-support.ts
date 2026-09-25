import { vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

export const maybeCompactAgentHarnessSessionMock: Mock<
  (
    ...args: Parameters<typeof import("../harness/compaction.js").maybeCompactAgentHarnessSession>
  ) => Promise<unknown>
> = vi.fn(async () => undefined);

export function mockPendingNativeCompaction() {
  let signal: AbortSignal | undefined;
  const pending = {
    get signal() {
      return signal;
    },
    started: createDeferred(),
    terminal: createDeferred<{ ok: false; compacted: false; reason: string }>(),
  };
  maybeCompactAgentHarnessSessionMock.mockImplementationOnce(async (params) => {
    signal = params.abortSignal;
    pending.started.resolve(undefined);
    return await pending.terminal.promise;
  });
  return pending;
}
