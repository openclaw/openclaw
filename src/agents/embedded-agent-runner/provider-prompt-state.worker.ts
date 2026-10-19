import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { fingerprintMessage } from "./prompt-cache-history.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";
import type { PromptPreparationTask, PromptPreparationResult } from "./provider-prompt-state.js";

serveWorkerTasks<PromptPreparationResult>(
  (input) => {
    // SAFETY: The prompt preparation pool is the only sender of this task union.
    const task = input as PromptPreparationTask;
    return "history" in task
      ? {
          kind: "history",
          fingerprints: task.history.map((message) => {
            const { stringBlock: _stringBlock, ...fingerprint } = fingerprintMessage(message);
            return fingerprint;
          }),
        }
      : { kind: "provider", prompt: prepareProviderPrompt(task) };
  },
  {
    transferList: (result) =>
      result.kind === "provider" && result.prompt.encoded
        ? [result.prompt.encoded.body.buffer]
        : [],
  },
);
