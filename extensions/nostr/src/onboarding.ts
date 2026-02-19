import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateSecretKey, nip19, SimplePool } from "nostr-tools";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import {
  formatDocsLink,
  DEFAULT_ACCOUNT_ID,
  type ChannelOnboardingAdapter,
} from "openclaw/plugin-sdk";
import type { NostrProfile } from "./config-schema.js";
import {
  DEFAULT_RELAYS,
  getPublicKeyFromPrivate,
  normalizeRelayUrls,
  validatePrivateKey,
} from "./nostr-bus.js";
import { publishProfile as publishProfileEvent } from "./nostr-profile.js";
import { resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;

const DEFAULT_OPENCLAW_PROFILE: NostrProfile = {
  name: "OpenClaw",
  about: "I am your OpenClaw agent",
  picture:
    "https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png",
};

const SENDER_KEYFILE_RELATIVE_PATH = ".openclaw/channels/nostr/.sender-private-key";

function resolveSenderPrivateKeyPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    throw new Error("HOME is not set");
  }
  return join(home, ...SENDER_KEYFILE_RELATIVE_PATH.split("/"));
}

async function writeSenderPrivateKeyForCurrentUser(privateKey: string): Promise<string> {
  const keyPath = resolveSenderPrivateKeyPath();
  await fs.mkdir(dirname(keyPath), { recursive: true });
  await fs.writeFile(keyPath, `${privateKey}\n`, { mode: 0o600 });
  return keyPath;
}

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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomNostrPrivateKeyHex(): string {
  return toHex(generateSecretKey());
}

function toNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim();
}

function pickProfileValue(existing: NostrProfile | undefined, key: keyof NostrProfile): string {
  const value = existing?.[key];
  return typeof value === "string" ? value : "";
}

function pickAllowFromValue(allowFrom: Array<string | number> | undefined): string {
  const first = Array.isArray(allowFrom) ? allowFrom[0] : undefined;
  return typeof first === "string" || typeof first === "number" ? String(first) : "";
}

async function collectNostrProfile({
  prompter,
  existing,
}: {
  prompter: WizardPrompter;
  existing?: NostrProfile;
}): Promise<NostrProfile | undefined> {
  const seedProfile = existing;
  const name = normalizeText(
    await prompter.text({
      message: "Profile name (optional)",
      initialValue: pickProfileValue(seedProfile, "name"),
    }),
  );
  const displayName = normalizeText(
    await prompter.text({
      message: "Profile display name (optional)",
      initialValue: pickProfileValue(seedProfile, "displayName"),
    }),
  );
  const about = normalizeText(
    await prompter.text({
      message: "Profile about/bio (optional)",
      initialValue: pickProfileValue(seedProfile, "about"),
    }),
  );
  const picture = normalizeText(
    await prompter.text({
      message: "Profile picture URL (https://, optional)",
      initialValue: pickProfileValue(seedProfile, "picture"),
      validate: () => undefined,
    }),
  );
  const banner = normalizeText(
    await prompter.text({
      message: "Profile banner URL (https://, optional)",
      initialValue: pickProfileValue(seedProfile, "banner"),
      validate: () => undefined,
    }),
  );
  const website = normalizeText(
    await prompter.text({
      message: "Profile website URL (https://, optional)",
      initialValue: pickProfileValue(seedProfile, "website"),
      validate: () => undefined,
    }),
  );
  const nip05 = normalizeText(
    await prompter.text({
      message: "NIP-05 identifier (optional)",
      initialValue: pickProfileValue(seedProfile, "nip05"),
    }),
  );
  const lud16 = normalizeText(
    await prompter.text({
      message: "LUD-16 address (optional)",
      initialValue: pickProfileValue(seedProfile, "lud16"),
    }),
  );

  const nextProfile: NostrProfile = {};
  if (name) nextProfile.name = name;
  if (displayName) nextProfile.displayName = displayName;
  if (about) nextProfile.about = about;
  if (picture) nextProfile.picture = picture;
  if (banner) nextProfile.banner = banner;
  if (website) nextProfile.website = website;
  if (nip05) nextProfile.nip05 = nip05;
  if (lud16) nextProfile.lud16 = lud16;

  return Object.keys(nextProfile).length === 0 ? undefined : nextProfile;
}

async function publishOnboardingProfile({
  privateKey,
  relays,
  profile,
  logInfo,
  logWarn,
}: {
  privateKey: string;
  relays: string[];
  profile: NostrProfile;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): Promise<boolean> {
  if (Object.keys(profile).length === 0) {
    return true;
  }

  const normalizedRelays = normalizeRelayUrls(relays);
  if (normalizedRelays.length === 0) {
    logWarn?.("Nostr onboarding profile publish skipped: no relays configured.");
    return false;
  }

  try {
    const sk = validatePrivateKey(privateKey);
    const pool = new SimplePool();
    try {
      const result = await publishProfileEvent(pool, sk, normalizedRelays, profile);
      const totalRelays = result.successes.length + result.failures.length;
      if (result.successes.length > 0) {
        logInfo?.(`Published Nostr profile to ${result.successes.length}/${totalRelays} relay(s).`);
        return true;
      }

      const failures = result.failures
        .map((failure) => `${failure.relay}: ${failure.error}`)
        .join(", ");
      logWarn?.(`Nostr profile publish failed on all relays: ${failures}`);
      return false;
    } finally {
      pool.close(normalizedRelays);
    }
  } catch (error) {
    logWarn?.(`Failed to publish Nostr profile on onboarding: ${String(error)}`);
    return false;
  }
}

async function noteNostrSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Nostr setup creates the two identity keys and relay settings used by this bot.",
      "First keypair: bot identity (the bot that receives and sends messages). Leave blank to generate a secure key.",
      "Second keypair: your sender identity (the key you will use from your client to send to this bot).",
      "Tip: if you don't have a sender key, one will be generated for you.",
      "Leave relay URLs blank to use defaults.",
      "Use your own bot identity for the first keypair, or use the generated one.",
      `Defaults for relays: ${DEFAULT_RELAYS.join(", ")}.`,
      "Profile metadata is optional, but setting it now prevents showing raw npub to clients.",
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
  configure: async ({ cfg, prompter, runtime }) => {
    let next = cfg;
    const resolved = resolveNostrAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    const existingNostr = resolved.config;
    if (!resolved.configured) {
      await noteNostrSetup(prompter);
    }

    const providedPrivateKey = String(
      await prompter.text({
        message: "OpenClaw bot private key (hex or nsec) — leave blank to generate now",
        initialValue: resolved.privateKey || "",
        validate: () => undefined,
      }),
    ).trim();

    const privateKey = providedPrivateKey || resolved.privateKey || randomNostrPrivateKeyHex();
    const generated = !providedPrivateKey && !resolved.privateKey;
    if (generated) {
      const botPubkey = getPublicKeyFromPrivate(privateKey);
      await prompter.note(
        [
          "Generated a Nostr keypair for this identity.",
          `Bot pubkey (npub): ${toNpub(botPubkey)}`,
          "This private key is sensitive. Keep it private and never paste it into logs or chats.",
          "Save it in a secure place (for example a password manager or secure env var) if you need to send messages directly.",
        ].join("\n"),
        "Nostr identity generated",
      );
    }

    const relayInput = String(
      await prompter.text({
        message: `Nostr relay URLs (comma- or newline-separated, leave blank for defaults: ${DEFAULT_RELAYS.join(", ")})`,
        placeholder: DEFAULT_RELAYS.join(", "),
        initialValue: resolved.config.relays?.join(", ") ?? DEFAULT_RELAYS.join(", "),
      }),
    ).trim();
    const relays = relayInput.length > 0 ? parseRelayList(relayInput) : [...DEFAULT_RELAYS];

    const allowFromInput = normalizeText(
      await prompter.text({
        message:
          "Your sender pubkey (npub or hex) allowed to message this bot (defaults to generated key)",
        initialValue: pickAllowFromValue(existingNostr.allowFrom),
        validate: () => undefined,
      }),
    );
    const hasExistingAllowFrom = existingNostr.allowFrom?.length;
    let hasAllowFrom = allowFromInput.trim() !== "";
    let allowFromValue = hasAllowFrom ? [allowFromInput] : existingNostr.allowFrom;

    if (!hasAllowFrom && !hasExistingAllowFrom) {
      const senderPrivateKey = randomNostrPrivateKeyHex();
      const senderPubkey = getPublicKeyFromPrivate(senderPrivateKey);
      hasAllowFrom = true;
      allowFromValue = [senderPubkey];
      const senderPrivateKeyPath = await writeSenderPrivateKeyForCurrentUser(
        senderPrivateKey,
      ).catch(() => "the key could not be persisted");

      await prompter.note(
        [
          "Generated a sender keypair for inbound messaging to this bot.",
          `Sender pubkey (npub): ${toNpub(senderPubkey)}`,
          "Treat this key as your personal sender identity.",
          "Keep this private key secret and store it safely.",
          `Saved for this local user only: ${senderPrivateKeyPath}`,
          "Load it into NOSTR_SENDER_SECRET for scriptable tools.",
        ].join("\n"),
        "Sender keypair generated",
      );
    } else if (hasAllowFrom) {
      allowFromValue = [allowFromInput];
    }

    const shouldSetupProfile = await prompter.confirm({
      message: "Set up Nostr profile metadata now (recommended so clients don't show raw npub)?",
      initialValue: true,
    });
    let profile: NostrProfile | undefined = resolved.config.profile;
    if (shouldSetupProfile) {
      const useDefaultProfile = await prompter.confirm({
        message: "Use OpenClaw profile defaults as the base (name, about, avatar)?",
        initialValue: true,
      });
      const existingProfileSeed = useDefaultProfile
        ? { ...DEFAULT_OPENCLAW_PROFILE, ...resolved.config.profile }
        : resolved.config.profile;
      profile = await collectNostrProfile({ prompter, existing: existingProfileSeed });
    }

    next = {
      ...next,
      channels: {
        ...next.channels,
        nostr: {
          ...next.channels?.nostr,
          enabled: true,
          privateKey,
          ...(relays.length > 0 ? { relays } : {}),
          ...(hasAllowFrom ? { dmPolicy: "allowlist", allowFrom: allowFromValue } : {}),
          ...(profile ? { profile } : {}),
        },
      },
    };

    if (
      process.env.NODE_ENV !== "test" &&
      shouldSetupProfile &&
      profile &&
      Object.keys(profile).length > 0
    ) {
      await publishOnboardingProfile({
        privateKey,
        relays,
        profile,
        logInfo: runtime?.log,
        logWarn: runtime?.error,
      });
    }

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
