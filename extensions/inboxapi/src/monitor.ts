/**
 * Polling-based inbound monitor for InboxAPI.
 * Polls for new emails and dispatches them to the agent.
 */

import { resolveAccessToken } from "./auth.js";
import type { InboxApiClientOptions } from "./client.js";
import { getEmails, getLastEmail, whoami } from "./client.js";
import { extractSenderEmail } from "./threading.js";
import type { ResolvedInboxApiAccount, InboxApiEmail } from "./types.js";

export interface MonitorDeps {
  account: ResolvedInboxApiAccount;
  deliver: (email: InboxApiEmail) => Promise<void>;
  log?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
  };
  abortSignal?: AbortSignal;
}

/**
 * Build client options from a resolved account.
 */
async function buildClientOptions(
  account: ResolvedInboxApiAccount,
): Promise<InboxApiClientOptions> {
  const accessToken = await resolveAccessToken(account);
  return {
    mcpEndpoint: account.mcpEndpoint,
    accessToken,
    fromName: account.fromName,
  };
}

/**
 * Start the polling loop for new emails.
 * Establishes a high-water mark on startup and polls for new emails.
 */
export async function startPolling(deps: MonitorDeps): Promise<void> {
  const { account, deliver, log, abortSignal } = deps;
  const clientOpts = await buildClientOptions(account);

  if (!clientOpts.accessToken) {
    log?.warn?.("InboxAPI: no access token available, polling disabled");
    return;
  }

  // Verify connectivity
  try {
    const identity = await whoami(clientOpts);
    log?.info?.(`InboxAPI: connected as ${identity.accountName} (${identity.email})`);
  } catch (err: any) {
    log?.error?.(`InboxAPI: failed to verify identity: ${err.message}`);
    return;
  }

  // Establish high-water mark from most recent email
  let lastSeenDate: string | undefined;
  let seenMessageIds = new Set<string>();

  try {
    const lastEmail = await getLastEmail(clientOpts);
    if (lastEmail) {
      lastSeenDate = lastEmail.date;
      seenMessageIds.add(lastEmail.messageId);
      log?.info?.(`InboxAPI: high-water mark set to ${lastSeenDate}`);
    } else {
      log?.info?.("InboxAPI: no existing emails, starting fresh");
    }
  } catch (err: any) {
    log?.warn?.(`InboxAPI: failed to get last email for high-water mark: ${err.message}`);
  }

  // Polling loop
  while (!abortSignal?.aborted) {
    await sleep(account.pollIntervalMs);
    if (abortSignal?.aborted) break;

    try {
      const emails = await getEmails(clientOpts, {
        limit: account.pollBatchSize,
        since: lastSeenDate,
      });

      // Filter to truly new emails (not yet seen)
      const newEmails = emails.filter((e) => !seenMessageIds.has(e.messageId));
      if (newEmails.length === 0) continue;

      // Process newest-first for high-water mark, but deliver oldest-first
      for (const email of newEmails.reverse()) {
        seenMessageIds.add(email.messageId);

        // Check DM policy
        const senderEmail = extractSenderEmail(email.from);
        if (!isAllowed(senderEmail, account)) {
          log?.info?.(`InboxAPI: rejected email from ${senderEmail} (not in allowlist)`);
          continue;
        }

        try {
          await deliver(email);
        } catch (err: any) {
          log?.error?.(`InboxAPI: failed to deliver email ${email.messageId}: ${err.message}`);
        }
      }

      // Update high-water mark to the most recent email
      const newestEmail = emails[0];
      if (newestEmail) {
        lastSeenDate = newestEmail.date;
      }

      // Prune seen set to avoid unbounded growth (keep last 1000)
      if (seenMessageIds.size > 1000) {
        const arr = Array.from(seenMessageIds);
        seenMessageIds = new Set(arr.slice(arr.length - 500));
      }
    } catch (err: any) {
      log?.error?.(`InboxAPI: poll error: ${err.message}`);
    }
  }
}

/** Check if a sender is allowed under the account's DM policy */
function isAllowed(senderEmail: string, account: ResolvedInboxApiAccount): boolean {
  switch (account.dmPolicy) {
    case "disabled":
      return false;
    case "open":
      return true;
    case "allowlist":
    case "pairing":
      if (account.allowFrom.length === 0) return false;
      return account.allowFrom.includes(senderEmail.toLowerCase());
    default:
      return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
