/** Node hosts refuse request-scoped PATH overrides, so configured pathPrepend never reaches them. */
export const EXEC_NODE_PATH_PREPEND_WARNING =
  "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.";

/** Detached node results arrive after the approval reply; keep the PATH hint beside the outcome. */
export function withNodePathPrependWarning(resultText: string, warn: boolean): string {
  return warn ? `${resultText}\n\n${EXEC_NODE_PATH_PREPEND_WARNING}` : resultText;
}
