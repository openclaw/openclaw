import type { PluginServiceSessionWorkV1 } from "openclaw/plugin-sdk/plugin-entry";

/** Feature execution contract. The host supplies its live assertion, either from
 * an invocation or a freshly reauthorized service borrow; saved fields are data.
 */
export type ResearchExecution = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  /** Issued by the current host target; never read from tool arguments or saved jobs. */
  lifecycleRevision?: string;
  assertInvocationCurrent: () => void;
};

/** Model-tool contexts carry a UUID but not the full incarnation; borrow it from the host. */
export async function withResearchExecution<T>(
  sessionWork: PluginServiceSessionWorkV1 | undefined,
  context: ResearchExecution,
  work: (current: ResearchExecution) => Promise<T>,
): Promise<T> {
  context.assertInvocationCurrent();
  const { agentId, sessionKey, sessionId } = context;
  if (!sessionWork || !agentId || !sessionKey || !sessionId) {
    throw new Error("Research requires the current Gateway conversation authority.");
  }
  return sessionWork.withCurrent({ agentId, sessionKey, toolName: "deep_research" }, (current) => {
    const assertInvocationCurrent = () => {
      context.assertInvocationCurrent();
      current.assertCurrent();
      if (current.target.sessionId !== sessionId) {
        throw new Error("Research conversation changed during invocation.");
      }
    };
    assertInvocationCurrent();
    return work({ ...current.target, assertInvocationCurrent });
  });
}
