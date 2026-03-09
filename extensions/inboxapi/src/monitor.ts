/**
 * Polling-based inbound monitor for InboxAPI.
 * Polls for new emails and dispatches them to the agent.
 */

import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/inboxapi";
import { resolveAccessToken } from "./auth.js";
import type { InboxApiClientOptions } from "./client.js";
import { getEmails, getLastEmail, whoami } from "./client.js";
import { extractSenderEmail } from "./threading.js";
import type { InboxApiEmail, ResolvedInboxApiAccount } from "./types.js";

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

  // Establish high-water mark from most recent email.
  // Fail closed: if we can't establish the mark, stop polling to avoid
  // replaying old inbox messages into the agent.
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
    log?.error?.(
      `InboxAPI: failed to establish high-water mark, refusing to poll to avoid replaying old messages: ${err.message}`,
    );
    return;
  }

  // Polling loop
  while (!abortSignal?.aborted) {
    await sleep(account.pollIntervalMs);
    if (abortSignal?.aborted) break;

    try {
      // Fetch pages until all new emails are consumed, so we never
      // advance the high-water mark past unprocessed messages.
      let pageSince = lastSeenDate;
      let latestDate = lastSeenDate;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (abortSignal?.aborted) break;

        const emails = await getEmails(clientOpts, {
          limit: account.pollBatchSize,
          since: pageSince,
        });

        // Filter to truly new emails (not yet seen)
        const newEmails = emails.filter((e) => !seenMessageIds.has(e.messageId));
        if (newEmails.length === 0) break;

        // Deliver oldest-first
        for (const email of newEmails.reverse()) {
          // Check DM policy (including pairing store)
          const senderEmail = extractSenderEmail(email.from);
          const allowed = await checkAccess(senderEmail, account);
          if (!allowed) {
            seenMessageIds.add(email.messageId);
            log?.info?.(`InboxAPI: rejected email from ${senderEmail} (not allowed by DM policy)`);
            continue;
          }

          try {
            await deliver(email);
            // Mark as seen only after successful delivery so transient
            // failures are retried on the next poll cycle.
            seenMessageIds.add(email.messageId);
          } catch (err: any) {
            log?.error?.(`InboxAPI: failed to deliver email ${email.messageId}: ${err.message}`);
          }
        }

        // Track the newest date we've processed in this page.
        // Don't assume any particular ordering — find the max date explicitly.
        for (const e of emails) {
          if (!latestDate || e.date > latestDate) {
            latestDate = e.date;
          }
        }
        // Advance page cursor to latest date to avoid re-fetching
        if (latestDate) {
          pageSince = latestDate;
        }

        // If we got fewer than a full page, no more pages to fetch
        if (emails.length < account.pollBatchSize) break;
      }

      // Only advance high-water mark after all pages are consumed
      if (latestDate) {
        lastSeenDate = latestDate;
      }

      // Prune seen set to avoid unbounded growth: when it exceeds 1000,
      // trim down to the most recent 500 entries.
      if (seenMessageIds.size > 1000) {
        const arr = Array.from(seenMessageIds);
        seenMessageIds = new Set(arr.slice(arr.length - 500));
      }
    } catch (err: any) {
      log?.error?.(`InboxAPI: poll error: ${err.message}`);
    }
  }
}

/** Check if a sender is allowed under the account's DM policy, including pairing store */
async function checkAccess(
  senderEmail: string,
  account: ResolvedInboxApiAccount,
): Promise<boolean> {
  // Read pairing store approvals for pairing/open policies
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "inboxapi",
    accountId: account.accountId,
    dmPolicy: account.dmPolicy,
  });

  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: account.dmPolicy,
    groupPolicy: "disabled",
    allowFrom: account.allowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    isSenderAllowed: (allowEntries) =>
      allowEntries.some((entry) => entry.toLowerCase() === senderEmail.toLowerCase()),
  });

  return access.decision === "allow";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
