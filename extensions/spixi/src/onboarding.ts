import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "openclaw/plugin-sdk";
import type { DmPolicy } from "openclaw/plugin-sdk";
import { listSpixiAccountIds, resolveSpixiAccount } from "./accounts.js";
import type { SpixiAccountConfig } from "./types.js";

const channel = "spixi" as const;

function getSpixiConfig(cfg: OpenClawConfig): SpixiAccountConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const spixi = channels?.spixi;
  if (spixi && typeof spixi === "object") {
    return spixi as SpixiAccountConfig;
  }
  return {};
}

function setSpixiDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      spixi: {
        ...cfg.channels?.spixi,
        dmPolicy,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Spixi",
  channel,
  policyKey: "channels.spixi.dmPolicy",
  allowFromKey: "channels.spixi.allowFrom",
  getCurrent: (cfg) => getSpixiConfig(cfg).dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setSpixiDmPolicy(cfg, policy),
};

export const spixiOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const accountIds = listSpixiAccountIds(cfg);
    const configured = accountIds.some((accountId) => {
      const account = resolveSpixiAccount({ cfg, accountId });
      return account.enabled && account.config.mqttHost;
    });
    return {
      channel,
      configured,
      statusLines: [
        `Spixi: ${configured ? "configured" : "needs setup"}`,
        "Requires: MQTT broker + QuIXI node",
      ],
      selectionHint: configured ? "MQTT configured" : "MQTT not configured",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    let next = cfg;

    await prompter.note(
      [
        "Spixi uses decentralized P2P messaging via the Ixian network.",
        "",
        "Before continuing, please install:",
        "",
        "1. MQTT Broker (for real-time messages):",
        "   • Mosquitto: https://mosquitto.org/download/",
        "   • or Aedes (Node.js): npm install aedes",
        "",
        "2. QuIXI Node (Ixian API bridge):",
        "   • https://github.com/ixian-platform/QuIXI",
        "",
        "3. Spixi Wallet:",
        "   • https://spixi.io/",
      ].join("\n"),
      "Spixi Prerequisites",
    );

    const mqttHost = String(
      await prompter.text({
        message: "MQTT broker hostname",
        placeholder: "127.0.0.1",
        initialValue: getSpixiConfig(cfg).mqttHost ?? "127.0.0.1",
      }),
    ).trim();

    const mqttPortRaw = String(
      await prompter.text({
        message: "MQTT broker port",
        placeholder: "1883",
        initialValue: String(getSpixiConfig(cfg).mqttPort ?? 1883),
        validate: (value) => {
          const num = Number(value);
          if (!Number.isFinite(num) || num <= 0 || num > 65535) {
            return "Invalid port number";
          }
          return undefined;
        },
      }),
    ).trim();
    const mqttPort = Number(mqttPortRaw);

    const quixiApiUrl = String(
      await prompter.text({
        message: "QuIXI API URL",
        placeholder: "http://localhost:8001",
        initialValue: getSpixiConfig(cfg).quixiApiUrl ?? "http://localhost:8001",
      }),
    ).trim();

    const myWalletAddress = String(
      await prompter.text({
        message: "Your Ixian wallet address (to filter self-messages)",
        placeholder: "Leave blank to skip",
        initialValue: getSpixiConfig(cfg).myWalletAddress ?? "",
      }),
    ).trim();

    next = {
      ...next,
      channels: {
        ...next.channels,
        spixi: {
          ...next.channels?.spixi,
          enabled: true,
          mqttHost,
          mqttPort,
          quixiApiUrl,
          ...(myWalletAddress ? { myWalletAddress } : {}),
        },
      },
    } as OpenClawConfig;

    await prompter.note(
      [
        "Spixi configuration saved!",
        "",
        `MQTT: mqtt://${mqttHost}:${mqttPort}`,
        `QuIXI API: ${quixiApiUrl}`,
        myWalletAddress ? `Wallet: ${myWalletAddress}` : "",
        "",
        "Run 'openclaw gateway' to start the Spixi bridge.",
      ]
        .filter(Boolean)
        .join("\n"),
      "Spixi configured",
    );

    return { cfg: next };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      spixi: { ...cfg.channels?.spixi, enabled: false },
    },
  }),
};
