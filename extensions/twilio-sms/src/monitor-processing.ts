import {
  buildAccountScopedDmSecurityPolicy,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/compat";
import {
  createReplyPrefixOptions,
  createScopedPairingAccess,
  issuePairingChallenge,
  normalizeE164,
  resolveDmGroupAccessWithLists,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "openclaw/plugin-sdk/twilio-sms";
import type { WebhookTarget } from "./monitor.js";
import { checkPinAuth } from "./pin-auth.js";
import { sendTwilioSms } from "./send.js";
import { normalizeTwilioSmsAllowEntry } from "./targets.js";
import type { TwilioSmsWebhookPayload } from "./types.js";

/**
 * Process an inbound SMS message through the full pipeline:
 * 1. Normalize sender → E.164
 * 2. PIN auth check (if enabled)
 * 3. Allowlist / pairing check
 * 4. Build route + envelope
 * 5. Dispatch to agent with a deliver callback that sends the reply via SMS
 */
export async function processTwilioSmsMessage(params: {
  payload: TwilioSmsWebhookPayload;
  target: WebhookTarget;
}): Promise<void> {
  const { payload, target } = params;
  const { account, config, core, runtime, statusSink } = target;

  const senderE164 = normalizeE164(payload.from);
  let messageBody = payload.body;

  // --- PIN auth ---
  if (account.config.pinAuth && account.config.pin) {
    const pinResult = checkPinAuth({
      senderE164,
      body: messageBody,
      pin: account.config.pin,
      accountId: account.accountId,
    });
    if (!pinResult.ok) {
      await sendTwilioSms({
        to: senderE164,
        body: "Authentication required. Send your PIN to continue.",
        accountSid: account.config.accountSid!,
        authToken: account.config.authToken!,
        from: account.config.phoneNumber!,
      });
      return;
    }
    messageBody = pinResult.strippedBody;
    // If the PIN was the entire message (no content after stripping), do nothing.
    if (!messageBody) {
      await sendTwilioSms({
        to: senderE164,
        body: "Authenticated. Send a message.",
        accountSid: account.config.accountSid!,
        authToken: account.config.authToken!,
        from: account.config.phoneNumber!,
      });
      return;
    }
  }

  // --- Allowlist / pairing ---
  const dmPolicy = buildAccountScopedDmSecurityPolicy({
    cfg: config,
    channelKey: "twilio-sms",
    accountId: account.accountId,
    fallbackAccountId: account.accountId,
    policy: account.config.dmPolicy,
    allowFrom: account.config.allowFrom ?? [],
    policyPathSuffix: "dmPolicy",
    normalizeEntry: (raw) => normalizeTwilioSmsAllowEntry(raw),
  });

  const pairing = createScopedPairingAccess({
    core,
    channel: "twilio-sms",
    accountId: account.accountId,
  });

  const allowFrom = mapAllowFromEntries(account.config.allowFrom);
  const normalizedAllowFrom = allowFrom.map((entry) => normalizeTwilioSmsAllowEntry(String(entry)));

  // Read store allowlist (from pairing approvals)
  const storeAllowFrom =
    dmPolicy.policy !== "allowlist" ? await pairing.readAllowFromStore().catch(() => []) : [];

  const isSenderAllowed = (entries: string[]): boolean => {
    const normalizedEntries = new Set(entries.map((e) => normalizeTwilioSmsAllowEntry(e)));
    return normalizedEntries.has(senderE164);
  };

  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: dmPolicy.policy,
    groupPolicy: "disabled",
    allowFrom: normalizedAllowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    isSenderAllowed,
  });

  if (access.decision !== "allow") {
    if (access.decision === "pairing") {
      await issuePairingChallenge({
        channel: "twilio-sms",
        senderId: senderE164,
        senderIdLine: `Phone: ${senderE164}`,
        upsertPairingRequest: pairing.upsertPairingRequest,
        sendPairingReply: async (text) => {
          await sendTwilioSms({
            to: senderE164,
            body: text,
            accountSid: account.config.accountSid!,
            authToken: account.config.authToken!,
            from: account.config.phoneNumber!,
          });
        },
        onReplyError: (err) => {
          runtime.error?.(`[twilio-sms] Pairing reply failed for ${senderE164}: ${String(err)}`);
        },
      });
      return;
    }
    // Sender is blocked — silently ignore.
    runtime.log?.(`[twilio-sms] Blocked DM from ${senderE164}: ${access.reason}`);
    return;
  }

  // --- Route + envelope ---
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "twilio-sms",
    accountId: account.accountId,
    peer: { kind: "direct" as const, id: senderE164 },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  const { storePath, body } = buildEnvelope({
    channel: "Twilio SMS",
    from: senderE164,
    timestamp: Date.now(),
    body: messageBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: messageBody,
    RawBody: messageBody,
    CommandBody: messageBody,
    From: `twilio-sms:${senderE164}`,
    To: `twilio-sms:${account.config.phoneNumber ?? ""}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: senderE164,
    SenderId: senderE164,
    CommandAuthorized: true,
    Provider: "twilio-sms",
    Surface: "twilio-sms",
    MessageSid: payload.messageSid,
    MessageSidFull: payload.messageSid,
    OriginatingChannel: "twilio-sms",
    OriginatingTo: `twilio-sms:${account.config.phoneNumber ?? ""}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`[twilio-sms] Failed updating session meta: ${String(err)}`);
    });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "twilio-sms",
    accountId: route.accountId,
  });

  // Dispatch to the agent and deliver the reply via SMS.
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        const text = typeof replyPayload === "string" ? replyPayload : (replyPayload.text ?? "");
        if (!text.trim()) {
          return;
        }

        // Twilio handles long message concatenation, but their API
        // limit is 1600 chars per message. Split at that boundary.
        const chunkLimit = account.config.textChunkLimit ?? 1600;
        const chunks = splitTextByLimit(text, chunkLimit);

        for (const chunk of chunks) {
          await sendTwilioSms({
            to: senderE164,
            body: chunk,
            accountSid: account.config.accountSid!,
            authToken: account.config.authToken!,
            from: account.config.phoneNumber!,
          });
        }

        statusSink?.({ lastOutboundAt: Date.now() });
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

/** Split text into chunks at the given character limit, preferring line breaks. */
function splitTextByLimit(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Try to split at a newline within the limit
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) {
      // Fall back to space
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      // Hard split
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^[\n ]/, "");
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
