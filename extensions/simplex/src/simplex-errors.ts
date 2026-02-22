export type SimplexCommandErrorResponse = {
  type?: string;
  chatError?: {
    type?: string;
    errorType?: {
      type?: string;
      message?: string;
    };
  };
};

export function resolveSimplexCommandError(
  resp: SimplexCommandErrorResponse | undefined,
): string | undefined {
  if (!resp || resp.type !== "chatCmdError") {
    return undefined;
  }
  const message = resp.chatError?.errorType?.message?.trim();
  if (message) {
    return message;
  }
  const errorType = resp.chatError?.errorType?.type?.trim();
  if (errorType) {
    return `SimpleX command error: ${errorType}`;
  }
  return "SimpleX command failed";
}
