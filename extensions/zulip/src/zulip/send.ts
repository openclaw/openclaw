import { parseZulipTarget } from "../normalize.js";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import { zulipSendMessage, type ZulipClient } from "./client.js";
import { resolveUserIdsForEmails } from "./users.js";

function resolveClient(accountId?: string | null): ZulipClient {
  const core = getZulipRuntime();
  const cfg = core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId });

  const baseUrl = account.baseUrl;
  const email = account.email?.trim();
  const apiKey = account.apiKey?.trim();
  if (!baseUrl) {
    throw new Error(
      `Zulip base URL missing for account "${account.accountId}" (set channels.zulip.realm or channels.zulip.site, or env ZULIP_REALM/ZULIP_SITE).`,
    );
  }
  if (!email || !apiKey) {
    throw new Error(
      `Zulip email/apiKey missing for account "${account.accountId}" (set channels.zulip.email/apiKey, or env ZULIP_EMAIL/ZULIP_API_KEY).`,
    );
  }
  return { baseUrl, email, apiKey };
}

export async function sendMessageZulip(
  to: string,
  text: string,
  opts: { accountId?: string | null } = {},
): Promise<{ messageId?: string } & ({ ok: true } | { ok: false; error: Error })> {
  const client = resolveClient(opts.accountId);
  const target = parseZulipTarget(to);

  try {
    if (target.kind === "stream") {
      const result = await zulipSendMessage(client, {
        type: "stream",
        stream: target.stream,
        topic: target.topic,
        content: text,
      });
      return { ok: true, messageId: result?.id != null ? String(result.id) : undefined };
    }

    const userIds = await resolveUserIdsForEmails(client, target.recipients);
    const result = await zulipSendMessage(client, {
      type: "private",
      to: userIds,
      content: text,
    });
    return { ok: true, messageId: result?.id != null ? String(result.id) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
