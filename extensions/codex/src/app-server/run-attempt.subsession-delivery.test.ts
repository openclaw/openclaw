import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  createParams,
  createResumeHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks({ sessionOwner: null });

it("resumes a message-less child thread through its internal completion contract", async () => {
  const params = createParams(path.join(tempDir, "child.jsonl"), path.join(tempDir, "workspace"), {
    sessionKey: "agent:main:subagent:synthetic-child",
  });
  params.agentId = "main";
  const target = {
    agentId: "main",
    sessionKey: params.sessionKey!,
    sessionId: params.sessionId,
    storePath: path.join(tempDir, "sessions.json"),
  };
  params.sessionTarget = target;
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: params.sessionId, updatedAt: Date.now(), spawnedBy: "agent:main:parent" },
  });
  params.disableMessageTool = true;
  params.sourceReplyDeliveryMode = "automatic";
  setCodexTestModelSupportsTools(params, true);
  setCodexTestToolFactory(params, () => []);
  const threadId = "existing-child";
  await writeCodexAppServerBinding(params.sessionFile, {
    threadId,
    cwd: params.workspaceDir,
    model: params.modelId,
    modelProvider: "openai",
    dynamicToolsFingerprint: "[]",
    webSearchThreadConfigFingerprint: JSON.stringify({
      "features.standalone_web_search": false,
      web_search: "disabled",
    }),
  });
  const harness = createResumeHarness(threadId);
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  await harness.notify({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "child-final",
            phase: "final_answer",
            text: "SYNTHETIC_CHILD_RESULT",
          },
        ],
      },
    },
  });
  const result = await run;
  expect(harness.requests.some((request) => request.method === "thread/resume")).toBe(true);
  expect(JSON.stringify(result.messagesSnapshot)).toContain("SYNTHETIC_CHILD_RESULT");
});
