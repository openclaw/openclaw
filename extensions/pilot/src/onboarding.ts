import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  patchScopedAccountConfig,
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type DmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk/pilot";
import {
  listPilotAccountIds,
  resolveDefaultPilotAccountId,
  resolvePilotAccount,
} from "./accounts.js";
import { normalizePilotAllowEntry } from "./normalize.js";
import type { CoreConfig, PilotAccountConfig } from "./types.js";

const channel = "pilot" as const;

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function updatePilotAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<PilotAccountConfig>,
): CoreConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch,
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  }) as CoreConfig;
}

function setPilotDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "pilot",
    dmPolicy,
  }) as CoreConfig;
}

async function noteSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Pilot Protocol needs a hostname for your agent.",
      "The hostname is your agent's human-readable identity on the network.",
      "Optional: socketPath (default: /tmp/pilot.sock), registry address.",
      "Env vars: PILOT_HOSTNAME, PILOT_SOCKET, PILOT_REGISTRY, PILOTCTL_PATH.",
    ].join("\n"),
    "Pilot setup",
  );
}

async function promptPilotAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<CoreConfig> {
  const existing = params.cfg.channels?.pilot?.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist Pilot DMs by sender.",
      "Use addresses (N:NNNN.HHHH.LLLL) or hostnames.",
      "Multiple entries: comma-separated.",
    ].join("\n"),
    "Pilot allowlist",
  );

  const raw = await params.prompter.text({
    message: "Pilot allowFrom (address or hostname)",
    placeholder: "alice-agent, 0:0000.0000.0005",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parsed = parseListInput(String(raw));
  const normalized = [
    ...new Set(parsed.map((entry) => normalizePilotAllowEntry(entry)).filter(Boolean)),
  ];

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      pilot: {
        ...params.cfg.channels?.pilot,
        allowFrom: normalized,
      },
    },
  } as CoreConfig;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Pilot",
  channel,
  policyKey: "channels.pilot.dmPolicy",
  allowFromKey: "channels.pilot.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.pilot?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setPilotDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: promptPilotAllowFrom,
};

export const pilotOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const coreCfg = cfg as CoreConfig;
    const configured = listPilotAccountIds(coreCfg).some(
      (accountId) => resolvePilotAccount({ cfg: coreCfg, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`Pilot: ${configured ? "configured" : "needs hostname"}`],
      selectionHint: configured ? "configured" : "needs hostname",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    let next = cfg as CoreConfig;
    const defaultAccountId = resolveDefaultPilotAccountId(next);
    const accountId = await resolveAccountIdForConfigure({
      cfg: next,
      prompter,
      label: "Pilot",
      accountOverride: accountOverrides.pilot,
      shouldPromptAccountIds,
      listAccountIds: listPilotAccountIds,
      defaultAccountId,
    });

    const resolved = resolvePilotAccount({ cfg: next, accountId });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envHostname = isDefaultAccount ? process.env.PILOT_HOSTNAME?.trim() : "";
    const envReady = Boolean(envHostname);

    if (!resolved.configured) {
      await noteSetupHelp(prompter);
    }

    let useEnv = false;
    if (envReady && isDefaultAccount && !resolved.config.hostname) {
      useEnv = await prompter.confirm({
        message: "PILOT_HOSTNAME detected. Use env var?",
        initialValue: true,
      });
    }

    if (useEnv) {
      next = updatePilotAccountConfig(next, accountId, { enabled: true });
    } else {
      const hostname = String(
        await prompter.text({
          message: "Agent hostname",
          initialValue: resolved.config.hostname || envHostname || undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const socketPath = String(
        await prompter.text({
          message: "Daemon socket path",
          initialValue: resolved.config.socketPath || "/tmp/pilot.sock",
        }),
      ).trim();

      const registry = String(
        await prompter.text({
          message: "Registry address (optional)",
          initialValue: resolved.config.registry || "",
        }),
      ).trim();

      next = updatePilotAccountConfig(next, accountId, {
        enabled: true,
        hostname,
        socketPath: socketPath || undefined,
        registry: registry || undefined,
      });
    }

    if (forceAllowFrom) {
      next = await promptPilotAllowFrom({ cfg: next, prompter, accountId });
    }

    await prompter.note(
      [
        "Next: ensure pilotctl + daemon are running, then restart gateway.",
        "Command: openclaw channels status --probe",
      ].join("\n"),
      "Pilot next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      pilot: {
        ...(cfg as CoreConfig).channels?.pilot,
        enabled: false,
      },
    },
  }),
};
