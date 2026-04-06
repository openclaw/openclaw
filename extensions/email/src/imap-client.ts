import { ImapFlow } from "imapflow";
import type { ResolvedEmailAccount } from "./accounts.js";
import { parseRawEmail, buildInboundText, type ParsedEmail } from "./parse.js";

export type FetchedMessage = ParsedEmail & {
  uid: string;
  inboundText: string;
};

const AUTH_MARKERS = [
  "authentication failed",
  "authenticationfailed",
  "login failed",
  "invalid credentials",
  "auth failed",
  "[authenticationfailed]",
];

const TRANSIENT_MARKERS = [
  "timed out",
  "timeout",
  "connection refused",
  "connection reset",
  "broken pipe",
  "temporary failure",
  "try again",
  "unavailable",
  "econnrefused",
  "econnreset",
  "epipe",
];

export function classifyImapError(err: unknown): "auth" | "transient" | "unknown" {
  const msg = String(err ?? "").toLowerCase();
  if (AUTH_MARKERS.some((m) => msg.includes(m))) return "auth";
  if (TRANSIENT_MARKERS.some((m) => msg.includes(m))) return "transient";
  return "unknown";
}

export function computeBackoffSeconds(
  kind: "auth" | "transient" | "unknown",
  failureCount: number,
  basePollSeconds: number,
): number {
  if (kind === "auth") {
    return Math.min(7200, Math.max(basePollSeconds, 900 * 2 ** (failureCount - 1)));
  }
  return Math.min(1800, Math.max(basePollSeconds, 120 * 2 ** (failureCount - 1)));
}

export async function fetchUnseenMessages(
  account: ResolvedEmailAccount,
): Promise<FetchedMessage[]> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapUseSsl,
    auth: {
      user: account.imapUsername,
      pass: account.imapPassword,
    },
    logger: false,
  });

  const results: FetchedMessage[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock(account.imapMailbox);
    try {
      for await (const msg of client.fetch("1:*", { envelope: true, uid: true, source: true }, { uid: false })) {
        if ((msg as any).flags?.has("\\Seen")) continue;

        const raw = (msg as any).source as Buffer | undefined;
        if (!raw) continue;

        const parsed = await parseRawEmail(raw, account.maxBodyChars);
        if (!parsed) continue;

        const uid = String((msg as any).uid ?? "");
        results.push({
          ...parsed,
          uid,
          inboundText: buildInboundText(parsed),
        });

        if (account.markSeen && uid) {
          await client.messageFlagsAdd({ uid: true } as any, ["\\Seen"], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }

  return results;
}
