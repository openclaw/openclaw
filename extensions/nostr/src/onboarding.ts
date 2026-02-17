import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import {
  formatDocsLink,
  DEFAULT_ACCOUNT_ID,
  type ChannelOnboardingAdapter,
} from "openclaw/plugin-sdk";
import { resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;

function parseRelayList(raw: string): string[] {
  const values = raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const uniq: string[] = [];
  for (const relay of values) {
    if (!uniq.includes(relay)) {
      uniq.push(relay);
    }
  }
  return uniq;
}

async function noteNostrSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Nostr setup requires a private key and relay URLs.",
      "Use your NIP-63-enabled identity and the relay URLs you want to publish/listen on.",
      `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
    ].join("\n"),
    "Nostr setup",
  );
}

export const nostrOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveNostrAccount({ cfg });
    const configured = account.configured;
    return {
      channel,
      configured,
      statusLines: [`Nostr: ${configured ? "configured" : "needs private key"}`],
      selectionHint: configured ? "configured" : "not configured",
      quickstartScore: configured ? 1 : 4,
    };
  },
  configure: async ({ cfg, prompter }) => {
    let next = cfg;
    const resolved = resolveNostrAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    if (!resolved.configured) {
      await noteNostrSetup(prompter);
    }

    const privateKey = String(
      await prompter.text({
        message: "Nostr private key (hex or nsec)",
        initialValue: resolved.privateKey || "",
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    const relayInput = String(
      await prompter.text({
        message: "Nostr relay URLs (comma- or newline-separated)",
        placeholder: "wss://relay.damus.io, wss://nos.lol",
        initialValue: resolved.config.relays?.join(", "),
      }),
    ).trim();
    const relays = parseRelayList(relayInput);

    next = {
      ...next,
      channels: {
        ...next.channels,
        nostr: {
          ...next.channels?.nostr,
          enabled: true,
          privateKey,
          ...(relays.length > 0 ? { relays } : {}),
        },
      },
    };

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      nostr: {
        ...(cfg.channels?.nostr as Record<string, unknown>),
        enabled: false,
      },
    },
  }),
};
