/**
 * Runtime seams used by subagent control for queue and embedded-run cancellation.
 */
export { clearSessionQueues } from "../auto-reply/reply/queue.js";
export {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "./embedded-agent-runner/runs.js";
