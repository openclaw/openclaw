/** Feature execution contract. The host supplies its live assertion, either from
 * an invocation or a freshly reauthorized service borrow; saved fields are data.
 */
export type ResearchExecution = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  assertInvocationCurrent: () => void;
};
