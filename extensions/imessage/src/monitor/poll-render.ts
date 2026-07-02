// Renders inbound native Messages polls into agent-visible text. Without this
// a poll balloon reaches the agent as the raw 0xFFFD placeholder its text
// column carries, so the agent sees an empty message and asks the sender to
// resend. imsg already decodes the poll (question/options/votes); this turns
// that structured event into a readable prompt the agent can act on, including
// numbered options so it can vote by 1-based index via the poll-vote action.
import type { IMessagePoll } from "./types.js";

export function renderIMessagePollBody(poll: IMessagePoll): string | null {
  const options = poll.options ?? [];

  // Vote update: surface who voted for what so the agent can follow tallies.
  if (poll.kind === "vote" || (poll.vote && options.length === 0)) {
    const vote = poll.vote;
    if (!vote) {
      return "\u{1F4CA} Poll vote received";
    }
    const who = vote.participant?.trim() || "someone";
    const what = vote.option_text?.trim() || vote.option_id || "an option";
    const verb = vote.event_type === "removed" ? "removed their vote for" : "voted for";
    return `\u{1F4CA} Poll vote: ${who} ${verb} "${what}"`;
  }

  if (options.length === 0) {
    return null;
  }

  const tally = new Map<string, number>();
  for (const vote of poll.votes ?? []) {
    if (vote.event_type === "removed" || !vote.option_id) {
      continue;
    }
    tally.set(vote.option_id, (tally.get(vote.option_id) ?? 0) + 1);
  }

  // Present the poll as a flat notification, not a question header with a
  // call-to-action. Rendering it as "Poll: <question>?" + "to vote, use…" made
  // the model treat it as a question to answer AND vote on (redundant echo).
  // A notification-style line lets it vote (options + indices retained) without
  // being nudged to also verbalize an answer.
  const optionList = options
    .map((option, index) => {
      const count = tally.get(option.id) ?? 0;
      return `${index + 1}) ${option.text}${count > 0 ? ` [${count}]` : ""}`;
    })
    .join("  ");
  const question = poll.question?.trim();
  return `[poll shared]${question ? ` ${question}` : ""} — options: ${optionList}`;
}
