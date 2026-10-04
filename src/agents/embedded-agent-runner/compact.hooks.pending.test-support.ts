import { createDeferred } from "../../../test/helpers/promise.js";
import {
  contextEngineCompactMock,
  maybeCompactAgentHarnessSessionMock,
} from "./compact.hooks.harness.js";

export function mockPendingContextEngineCompaction() {
  const pending = {
    signal: undefined as AbortSignal | undefined,
    started: createDeferred(),
    release: createDeferred(),
  };
  contextEngineCompactMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args;
    pending.signal = (params as { abortSignal?: AbortSignal }).abortSignal;
    pending.started.resolve(undefined);
    await pending.release.promise;
    return {
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensBefore: 120, tokensAfter: 50 },
    };
  });
  return pending;
}

export function mockPendingNativeCompaction() {
  const pending = {
    signal: undefined as AbortSignal | undefined,
    started: createDeferred(),
    terminal: createDeferred<{ ok: false; compacted: false; reason: string }>(),
  };
  maybeCompactAgentHarnessSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args;
    pending.signal = (params as { abortSignal?: AbortSignal }).abortSignal;
    pending.started.resolve(undefined);
    return await pending.terminal.promise;
  });
  return pending;
}
