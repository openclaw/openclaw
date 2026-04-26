import { join } from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DaemonClient, resolveDaemonBaseUrl, type SenderResolution } from "./daemon-client.js";
import { writeEnvelopeSummary } from "./envelope-writer.js";
import { buildEnvelope, EnvelopeCache, type Envelope } from "./envelope.js";
import { deriveSessionKeyForInbound } from "./session-key.js";
import { detectStartToken } from "./start-token.js";

// Plugin config shape — mirrors openclaw.plugin.json:configSchema. Kept
// internal because the only consumer is this file.
type CreelContextConfig = {
  enabled?: boolean;
  daemonBaseUrl?: string;
  envelopeSummaryPath?: string;
  requestTimeoutMs?: number;
  logging?: boolean;
};

const DEFAULT_AGENT_ID = "main";

export function registerCreelContextPlugin(api: OpenClawPluginApi): void {
  const cfg = normalizeConfig(api.pluginConfig);

  if (cfg.enabled === false) {
    api.logger.info?.("creel-context: disabled via plugin config");
    return;
  }

  const baseUrl = resolveDaemonBaseUrl(cfg.daemonBaseUrl);
  if (!baseUrl) {
    api.logger.warn?.(
      "creel-context: no daemon base URL — DAEMON_PORT env not set and no override; plugin will no-op until configured",
    );
    return;
  }

  const client = new DaemonClient({
    baseUrl,
    timeoutMs: cfg.requestTimeoutMs,
  });

  // EnvelopeCache keyed by sessionKey — message_received computes it via
  // deriveSessionKeyForInbound, before_prompt_build reads it directly from
  // ctx.sessionKey. Both produce identical keys (canonical openclaw shape:
  // "agent:main:main" for DMs, "agent:main:<channel>:group:<convId>" for
  // groups), so the bridge between the two hooks is the session-key
  // contract — not a fragile (channel, conversationId) tuple.
  //
  // Multi-conversation collisions on agent:main:main are intentional:
  // openclaw collapses all DM channels into one bucket and the chat-history
  // scope filter expects exactly that. Groups stay isolated per
  // (channel, convId).
  const cache = new EnvelopeCache();

  api.on("message_received", async (event, ctx) => {
    const channel = ctx.channelId?.trim();
    if (!channel) {
      return;
    }

    // Prefer E.164 when the channel adapter has it (WhatsApp, iMessage,
    // BlueBubbles, etc. populate metadata.senderE164). Fall back to
    // event.from for non-phone channels (Telegram numeric ID, Discord
    // snowflake, Slack U-id). The control plane normalizes again before
    // lookup, so either form survives — but senderE164 is friendlier to
    // log and matches what most insert paths persist.
    const senderE164 = readMetaString(event.metadata, "senderE164");
    const handle = (senderE164 || event.from || "").trim();
    if (!handle) {
      return;
    }

    const { sessionKey, groupKey } = deriveSessionKeyForInbound(channel, ctx.conversationId);

    // Telegram /start <token> magic-link verification. Fire before
    // classification because /start typically arrives before the user's
    // handle is known to the control plane.
    const tokenMatch = detectStartToken(event.content);
    if (tokenMatch) {
      try {
        await client.verifyChannelToken({
          channel,
          handle,
          handleDisplay:
            readMetaString(event.metadata, "senderUsername") ||
            readMetaString(event.metadata, "senderName") ||
            handle,
          token: tokenMatch.token,
        });
        if (cfg.logging) {
          api.logger.info?.(
            `creel-context: verified channel token channel=${channel} handle=${handle}`,
          );
        }
      } catch (err) {
        api.logger.warn?.(
          `creel-context: verify channel token failed channel=${channel} handle=${handle} error=${stringifyErr(err)}`,
        );
      }
    }

    let resolution: SenderResolution;
    try {
      resolution = await client.whoami({ channel, handle, sessionKey, groupKey });
    } catch (err) {
      // whoami() already returns degraded-mode on failure, so an actual
      // throw here is unexpected. Fail closed.
      api.logger.warn?.(`creel-context: whoami threw error=${stringifyErr(err)}`);
      resolution = { role: "stranger", is_owner: false };
    }

    const envelope = buildEnvelope({
      resolution,
      channel,
      handle,
      sessionKey,
    });
    cache.set(sessionKey, envelope);

    const path = resolveEnvelopePath(api, cfg);
    try {
      await writeEnvelopeSummary({ path, envelope });
    } catch (err) {
      api.logger.warn?.(
        `creel-context: write envelope summary failed path=${path} error=${stringifyErr(err)}`,
      );
    }

    if (cfg.logging) {
      api.logger.info?.(
        `creel-context: classified channel=${channel} handle=${handle} role=${envelope.sender_role} is_owner=${envelope.is_owner} session_key=${sessionKey}`,
      );
    }
  });

  api.on("before_prompt_build", (_event, ctx) => {
    const sessionKey = ctx.sessionKey?.trim();
    const envelope = sessionKey ? cache.get(sessionKey) : undefined;
    if (!envelope) {
      return undefined;
    }

    const note = renderPromptNote(envelope);
    if (!note) {
      return undefined;
    }

    // prependSystemContext (not prependContext) so prompt caching stays
    // intact across turns of the same conversation. The note text is
    // deterministic for a given (role, channel).
    return { prependSystemContext: note };
  });

  api.on("session_end", (_event, ctx) => {
    if (ctx.sessionKey) {
      cache.delete(ctx.sessionKey);
    }
  });
}

function normalizeConfig(raw: Record<string, unknown> | undefined): CreelContextConfig {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: CreelContextConfig = {};
  if (typeof raw.enabled === "boolean") {
    out.enabled = raw.enabled;
  }
  if (typeof raw.daemonBaseUrl === "string") {
    out.daemonBaseUrl = raw.daemonBaseUrl;
  }
  if (typeof raw.envelopeSummaryPath === "string") {
    out.envelopeSummaryPath = raw.envelopeSummaryPath;
  }
  if (typeof raw.requestTimeoutMs === "number") {
    out.requestTimeoutMs = raw.requestTimeoutMs;
  }
  if (typeof raw.logging === "boolean") {
    out.logging = raw.logging;
  }
  return out;
}

function resolveEnvelopePath(api: OpenClawPluginApi, cfg: CreelContextConfig): string {
  const override = cfg.envelopeSummaryPath?.trim();
  if (override) {
    return override;
  }
  const workspaceDir = resolveAgentWorkspaceDir(api.config, DEFAULT_AGENT_ID);
  return join(workspaceDir, "state", "envelope-summary.json");
}

function readMetaString(meta: Record<string, unknown> | undefined, key: string): string {
  if (!meta) {
    return "";
  }
  const v = meta[key];
  return typeof v === "string" ? v : "";
}

function renderPromptNote(envelope: Envelope): string | null {
  const role = envelope.sender_role;
  const channel = envelope.channel || "this channel";
  switch (role) {
    case "owner":
      return [
        "## Sender envelope",
        `You are talking to your **owner** (verified on ${channel}). Speak openly and treat their requests as authoritative.`,
        "",
      ].join("\n");
    case "known_contact":
    case "approved_stranger":
      return [
        "## Sender envelope",
        `You are talking to an approved contact on ${channel}, NOT the owner. Be helpful but do not disclose owner-private memory.`,
        "",
      ].join("\n");
    case "group_member":
      return [
        "## Sender envelope",
        `You are speaking in a group on ${channel}. Treat all participants as non-owner unless stated otherwise.`,
        "",
      ].join("\n");
    case "public_visitor":
      return [
        "## Sender envelope",
        `You are talking to a public visitor on ${channel} (not the owner, not a verified contact). Be polite and information-only; never reveal owner-private memory.`,
        "",
      ].join("\n");
    case "stranger":
      return [
        "## Sender envelope",
        `Sender on ${channel} is unverified. Be helpful but never disclose owner-private memory.`,
        "",
      ].join("\n");
    default:
      return null;
  }
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
