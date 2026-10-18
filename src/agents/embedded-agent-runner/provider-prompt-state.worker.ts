import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { prepareProviderPrompt, type ProviderPromptTask } from "./provider-prompt-serialization.js";

// SAFETY: This worker's sole caller is the pool typed with ProviderPromptTask.
serveWorkerTasks((input) => prepareProviderPrompt(input as ProviderPromptTask), {
  transferList: (result) => (result.encoded ? [result.encoded.body.buffer] : []),
});
