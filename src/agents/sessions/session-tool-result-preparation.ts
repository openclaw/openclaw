import { isDeepStrictEqual } from "node:util";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copyInternalToolResultState,
  clearInternalNativeInvocationStorage,
  getInternalNativeInvocationStorage,
  getInternalNativeInvocation,
  retainInternalNativeInvocation,
} from "../../../packages/agent-core/src/internal-hooks.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { AgentEvent, AgentMessage } from "../runtime/index.js";
import type { SessionManager } from "./session-manager.js";

type ToolResultPreparation = {
  cap: (
    message: Extract<AgentMessage, { role: "toolResult" }>,
  ) => Extract<AgentMessage, { role: "toolResult" }>;
};
const preparers = createSessionManagerRuntimeRegistry<ToolResultPreparation>();
const unchangedToolResult = () => false;

/** Bind the guard's size cap without extending the public SessionManager contract. */
export function setSessionToolResultPreparer(
  sessionManager: SessionManager,
  preparation: ToolResultPreparation,
): void {
  preparers.set(sessionManager, preparation);
}

export function createSessionToolResultPreparer(
  sessionManager: SessionManager,
  event: AgentEvent,
): () => boolean {
  if (event.type !== "message_end" || event.message.role !== "toolResult") {
    return unchangedToolResult;
  }
  let origin = getInternalNativeInvocation(event.message);
  const originalId = event.message.toolCallId;
  const originalName = event.message.toolName;
  return () => {
    const validOrigin =
      event.message.role === "toolResult" &&
      event.message.toolCallId === originalId &&
      event.message.toolName === originalName &&
      !event.message.isError
        ? origin
        : undefined;
    origin = validOrigin;
    retainInternalNativeInvocation(event.message, validOrigin);
    if (event.message.role !== "toolResult") {
      return false;
    }
    const message = event.message;
    const capped = preparers.get(sessionManager)?.cap(message) ?? message;
    if (capped === message) {
      return false;
    }
    if (Object.isFrozen(message)) {
      event.message = copyInternalToolResultState(message, freezeJsonSnapshot(capped));
    } else {
      message.content = capped.content;
    }
    retainInternalNativeInvocation(event.message, validOrigin);
    return true;
  };
}

/** Publish only the exact admitted stored result; returned copies cannot admit another append. */
export function retainPersistedSessionNativeInvocation(
  message: AgentMessage,
  prepared: AgentMessage,
  origin: ReturnType<typeof getInternalNativeInvocation>,
): void {
  const fact = getInternalNativeInvocationStorage(prepared);
  clearInternalNativeInvocationStorage(prepared);
  clearInternalNativeInvocationStorage(message);
  const metadata = asOptionalObjectRecord(asOptionalObjectRecord(message)?.["__openclaw"]);
  const matches =
    fact &&
    message.role === "toolResult" &&
    !message.isError &&
    message.toolCallId === fact.toolCallId &&
    message.toolName === fact.toolName &&
    metadata?.runId === fact.runId &&
    isDeepStrictEqual(metadata.nativeInvocation, fact);
  retainInternalNativeInvocation(message, matches ? origin : undefined);
}
