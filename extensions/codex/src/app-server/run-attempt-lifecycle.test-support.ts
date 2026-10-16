import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import * as attemptActiveTurn from "./run-attempt-active-turn.js";
import { runCodexAppServerAttempt } from "./run-attempt-test-harness.js";

export function startClockControlledAttempt(params: EmbeddedRunAttemptParams) {
  // Cold transcript workers must not consume a success scenario's execution budget.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const run = runCodexAppServerAttempt(params);
  return { run, started: run.waitForTurnAccepted() };
}

export function observeAttemptProjectionReady() {
  const activate = attemptActiveTurn.activateCodexAttemptTurn;
  const activated = createDeferred<ReturnType<typeof activate>>();
  vi.spyOn(attemptActiveTurn, "activateCodexAttemptTurn").mockImplementation((...args) => {
    const turn = activate(...args);
    activated.resolve(turn);
    return turn;
  });
  return () => activated.promise.then((turn) => turn.ready);
}

export async function expectRetainedSuccessfulThread(
  client: CodexAppServerClient,
  threadId: string,
) {
  const ownership = await consumeCodexAppServerLiveThread(client, threadId);
  expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
  // Restore the exact branded owner so this assertion itself cannot orphan
  // the persistent subscription or alter later cleanup in the same test.
  await expect(
    retainCodexAppServerLiveThread(
      client,
      threadId,
      ownership?.release,
      ownership?.configFingerprint,
      ownership?.serviceTier,
    ),
  ).resolves.toBe(true);
}
