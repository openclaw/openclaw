import path from "node:path";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import {
  createParams,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import {
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import {
  createTranscriptMirrorTestHarness,
  readMirrorRaw,
} from "./transcript-mirror.test-harness.js";

const { createSqliteMirrorTarget: createTarget } = createTranscriptMirrorTestHarness();
registerCodexEventProjectorTestLifecycle();

it("records private input consumption once after the accepted native prompt is mirrored", async () => {
  const target = await createTarget("openclaw-codex-private-consumption-");
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const consumed = vi.fn();
  const recorder = createRecorder({
    input: { text: "Continue the runtime event.", idempotencyKey: "announce:private:user" },
    target: () => ({ ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } }),
    onInputSubmitted: consumed,
  });
  const params = {
    ...(await createParams()),
    ...target,
    sessionTarget: target,
    workspaceDir: path.dirname(target.storePath),
    privateCompletion: true as const,
    userTurnTranscriptRecorder: recorder,
  };
  const notifyUserMessagePersisted = createCodexAppServerUserMessagePersistenceNotifier(params);
  const mirrorParams = {
    params,
    ...target,
    cwd: path.dirname(target.storePath),
    threadId: "thread-private",
    turnId: "turn-private",
    upstreamUserText: "Synthetic private child result",
    notifyUserMessagePersisted,
  };
  expect(consumed).not.toHaveBeenCalled();
  await mirrorPromptAtTurnStartBestEffort(mirrorParams);
  expect(await readMirrorRaw(target)).toContain("Synthetic private child result");
  expect(consumed).toHaveBeenCalledOnce();
  await mirrorPromptAtTurnStartBestEffort(mirrorParams);
  expect(consumed).toHaveBeenCalledOnce();
});
