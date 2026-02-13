import {
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { DmPolicy } from "./config-types.js";
import { resolveConvosAccount, listConvosAccountIds, type CoreConfig } from "./accounts.js";
import { ConvosInstance } from "./sdk-client.js";

const channel = "convos" as const;

// Convos invite URLs can be:
// - Full URL: https://convos.app/join/SLUG or convos://join/SLUG
// - Just the slug: a base64-encoded string with asterisks for iMessage compatibility
const INVITE_URL_PATTERNS = [/^https?:\/\/convos\.app\/join\/(.+)$/i, /^convos:\/\/join\/(.+)$/i];

function extractInviteSlug(input: string): string {
  const trimmed = input.trim();
  for (const pattern of INVITE_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return match[1];
    }
  }
  // Assume it's a raw slug
  return trimmed;
}

function isValidInviteInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  for (const pattern of INVITE_URL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  // Raw slug: should be base64 characters possibly with asterisks
  return /^[A-Za-z0-9+/=*_-]+$/.test(trimmed) && trimmed.length > 20;
}

function setConvosDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      convos: {
        ...(cfg.channels as CoreConfig["channels"])?.convos,
        dmPolicy,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Convos",
  channel,
  policyKey: "channels.convos.dmPolicy",
  allowFromKey: "channels.convos.allowFrom",
  getCurrent: (cfg) => (cfg.channels as CoreConfig["channels"])?.convos?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setConvosDmPolicy(cfg, policy),
};

export const convosOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const configured = listConvosAccountIds(cfg as CoreConfig).some(
      (accountId) => resolveConvosAccount({ cfg: cfg as CoreConfig, accountId }).configured,
    );
    const account = resolveConvosAccount({ cfg: cfg as CoreConfig });
    const ownerConversation = (cfg.channels as CoreConfig["channels"])?.convos?.ownerConversationId;

    return {
      channel,
      configured,
      statusLines: [
        `Convos: ${configured ? "configured" : "needs setup"}`,
        `Environment: ${account.env}`,
        ownerConversation ? `Owner conversation: ${ownerConversation.slice(0, 8)}...` : "",
      ].filter(Boolean),
      selectionHint: configured ? "ready" : "paste invite link",
      quickstartScore: 0,
    };
  },

  configure: async ({ cfg, prompter }) => {
    let next = cfg;
    const account = resolveConvosAccount({ cfg: next as CoreConfig });

    // Check for existing configuration
    if (account.ownerConversationId) {
      const keep = await prompter.confirm({
        message: `Convos already configured (conversation: ${account.ownerConversationId.slice(0, 12)}...). Keep it?`,
        initialValue: true,
      });
      if (keep) {
        return { cfg: next };
      }
    }

    // Explain the invite flow
    await prompter.note(
      [
        "To connect OpenClaw to Convos:",
        "",
        "1. Open the Convos iOS app",
        "2. Open a conversation (or create one)",
        '3. Tap the "+" button',
        "4. Tap the share button on the QR code",
        '5. Tap "Copy" (or AirDrop to your Mac)',
        "6. Paste the invite link below",
        "",
        "OpenClaw will join this conversation as your control channel.",
      ].join("\n"),
      "Convos Setup",
    );

    // Prompt for invite link
    const inviteInput = await prompter.text({
      message: "Paste Convos invite link or slug",
      placeholder: "https://convos.app/join/... or raw slug",
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) {
          return "Required";
        }
        if (!isValidInviteInput(raw)) {
          return "Invalid invite format. Paste the full URL or slug.";
        }
        return undefined;
      },
    });

    const inviteSlug = extractInviteSlug(String(inviteInput));

    // Join the conversation via CLI
    await prompter.note("Creating XMTP identity and joining conversation...", "Convos");

    try {
      const { instance, status, conversationId, identityId } = await ConvosInstance.join(
        account.env,
        inviteSlug,
        { profileName: "OpenClaw" },
      );

      if (!conversationId) {
        await prompter.note(
          status === "waiting_for_acceptance"
            ? "Join request sent. The conversation owner needs to approve your request in the Convos iOS app."
            : "Failed to join conversation. The invite may be invalid or expired.",
          "Convos",
        );

        // Save identityId so we can retry later with the same identity
        if (identityId) {
          next = {
            ...next,
            channels: {
              ...next.channels,
              convos: {
                ...(next.channels as CoreConfig["channels"])?.convos,
                enabled: true,
                identityId,
                env: account.env,
              },
            },
          };
        }

        return { cfg: next };
      }

      // Save identityId and ownerConversationId
      next = {
        ...next,
        channels: {
          ...next.channels,
          convos: {
            ...(next.channels as CoreConfig["channels"])?.convos,
            enabled: true,
            identityId: instance?.identityId ?? identityId,
            env: account.env,
            ownerConversationId: conversationId,
          },
        },
      };

      await prompter.note(
        [
          "Successfully joined conversation!",
          "",
          `Conversation ID: ${conversationId}`,
          "",
          "This is now your owner channel. OpenClaw will:",
          "- Send status updates here",
          "- Ask for approvals here",
          "- Communicate with you here",
        ].join("\n"),
        "Convos Connected",
      );
    } catch (err) {
      await prompter.note(
        `Failed to join: ${err instanceof Error ? err.message : String(err)}`,
        "Convos Error",
      );
    }

    return { cfg: next };
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      convos: {
        ...(cfg.channels as CoreConfig["channels"])?.convos,
        enabled: false,
      },
    },
  }),
};
