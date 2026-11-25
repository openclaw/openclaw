export type SlackResponseUrlBudget<TPayload> = {
  respond: (payload: TPayload) => Promise<unknown>;
  /** Remaining response_url calls, or undefined for an uncapped Web API transport. */
  remaining: () => number | undefined;
};

const SLACK_RESPONSE_URL_MAX_CALLS = 5;

export class SlackResponseAlreadyReportedError extends Error {}

/** Count every response_url attempt, including requests Slack rejects. */
export function createSlackResponseUrlBudget<TPayload>(
  respond: (payload: TPayload) => Promise<unknown>,
): SlackResponseUrlBudget<TPayload> {
  let remaining = SLACK_RESPONSE_URL_MAX_CALLS;
  return {
    remaining: () => remaining,
    respond: async (payload) => {
      if (remaining <= 0) {
        throw new Error("Slack response_url cannot be used more than 5 times.");
      }
      remaining -= 1;
      return await respond(payload);
    },
  };
}
