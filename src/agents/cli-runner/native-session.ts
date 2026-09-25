import { publishAgentRunNativeSession } from "../../infra/agent-run-native-session.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import type { PreparedCliRunContext } from "./types.js";

/**
 * Publish the Claude thread a turn is driving before the turn settles, so the
 * session catalog can see its owner while the CLI binding is not yet persisted.
 */
export function publishCliNativeSession(
  run: {
    params: PreparedCliRunContext["params"];
    backendId: string;
    nodePlacement: { nodeId: string } | null;
    assertCurrent: () => void;
  },
  threadId: string,
): void {
  const { params, backendId, nodePlacement, assertCurrent } = run;
  if (
    backendId !== "claude-cli" ||
    !params.sessionKey ||
    params.executionMode === "side-question" ||
    params.isolatedCompletion
  ) {
    return;
  }
  assertCurrent();
  const authority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  if (authority) {
    publishAgentRunNativeSession(authority, {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      backendId,
      hostId: nodePlacement ? "node:" + nodePlacement.nodeId : "gateway:local",
      threadId,
    });
  }
}
