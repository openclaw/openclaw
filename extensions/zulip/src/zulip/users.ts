import { zulipGetUsers, type ZulipClient, type ZulipUser } from "./client.js";

// Cache email -> user_id lookups to avoid fetching /users on every DM.
// Note: Zulip may redact "email" but expose "delivery_email"; we match both.
const emailToId = new Map<string, number>();
let lastSyncAt = 0;

function norm(email: string): string {
  return email.trim().toLowerCase();
}

export async function resolveUserIdsForEmails(
  client: ZulipClient,
  emails: string[],
  opts: { maxAgeMs?: number } = {},
): Promise<number[]> {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = Date.now();

  const wanted = emails.map(norm).filter(Boolean);
  const missing = wanted.filter((e) => !emailToId.has(e));
  const stale = now - lastSyncAt > maxAgeMs;

  if (stale || missing.length > 0) {
    const users = await zulipGetUsers(client);
    for (const u of users) {
      const userId = u.user_id;
      if (typeof userId !== "number") {
        continue;
      }

      const emailsToIndex: string[] = [];
      if (u.email) {
        emailsToIndex.push(u.email);
      }
      if (u.delivery_email) {
        emailsToIndex.push(u.delivery_email);
      }

      for (const e of emailsToIndex) {
        const key = norm(e);
        if (key) {
          emailToId.set(key, userId);
        }
      }
    }
    lastSyncAt = now;
  }

  const ids = wanted.map((e) => emailToId.get(e)).filter((v): v is number => typeof v === "number");

  // Ensure we didn't silently drop recipients.
  if (ids.length !== wanted.length) {
    const unresolved = wanted.filter((e) => !emailToId.has(e));
    throw new Error(`Invalid email '${unresolved[0] ?? ""}'`);
  }

  return ids;
}

export type { ZulipUser };
