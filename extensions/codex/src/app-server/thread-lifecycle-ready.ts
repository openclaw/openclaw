import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexStartOrResumeThreadParams,
  CodexResumeThreadContext,
} from "./thread-lifecycle-types.js";

export function recordCodexThreadReady(
  params: CodexStartOrResumeThreadParams,
  context: Pick<CodexResumeThreadContext, "contextEngineBinding" | "lifecycleTiming">,
  threadId: string,
  action: "resumed" | "rotated" | "started" | "forked",
): void {
  const { contextEngineBinding, lifecycleTiming } = context;
  const event = {
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    threadId,
    action,
  };
  if (contextEngineBinding) {
    embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
      ...event,
      engineId: contextEngineBinding.engineId,
      epoch: contextEngineBinding.projection?.epoch,
      fingerprint: contextEngineBinding.projection?.fingerprint,
    });
  }
  lifecycleTiming.mark("thread-ready");
  lifecycleTiming.logSummary({ runId: params.params.runId, ...event });
}
