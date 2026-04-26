// Detects Telegram-style /start <token> deep-link payloads in inbound
// message bodies.
//
// Background: Telegram bots can be reached via `t.me/<bot>?start=<token>`
// links. When the user clicks the link, Telegram sends `/start <token>` as
// the first message. We use that as the magic-link verification token —
// the token is single-use and is matched against
// challenge_verifications.token_hash on the control plane.
//
// The pattern matches Telegram's real `start` parameter alphabet
// ([A-Za-z0-9_-], no padding — see Telegram Bot API "Deep Linking" docs),
// length 16-256, and must be the FIRST whitespace-separated argument so
// "/start foo bar" treats only "foo" as the token (Telegram's contract).

const START_TOKEN_RE = /^\s*\/start(?:@\S+)?\s+([A-Za-z0-9_-]{16,256})(?:\s|$)/u;

export type StartTokenMatch = {
  token: string;
};

export function detectStartToken(body: string | undefined | null): StartTokenMatch | null {
  if (!body) {
    return null;
  }
  const match = body.match(START_TOKEN_RE);
  if (!match || !match[1]) {
    return null;
  }
  return { token: match[1] };
}
