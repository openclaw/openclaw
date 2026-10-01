export class SlackHuddlesInvalidRequestError extends Error {}

export function slackHuddlesInvalidRequest(message: string): SlackHuddlesInvalidRequestError {
  return new SlackHuddlesInvalidRequestError(message);
}
