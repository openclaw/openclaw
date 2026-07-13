// Signal plugin module implements setup core behavior.
import {
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  DEFAULT_ACCOUNT_ID,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
  type OpenClawConfig,
  createSetupTranslator,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount } from "./accounts.js";
import {
  buildNativeSignalSetupPatch,
  normalizeSignalAccountInput,
  patchSignalSetupConfigForAccount,
  resolveSignalNativeSetupHttpPort,
  resolveSignalNativeSetupPreferredPort,
  resolveSignalSetupChoiceFromConfig,
  resolveSignalSetupTransportFromCredentialValues,
  shouldScopeDefaultSignalSetupPatch,
  SIGNAL_PHONE_NUMBER_EXAMPLE,
  SIGNAL_SETUP_NATIVE_PORT_KEY,
  SIGNAL_SETUP_TRANSPORT_KEY,
  type SignalSetupTransport,
} from "./setup-config.js";
import {
  createSignalCliPathTextInput,
  signalDmPolicy,
  signalNumberTextInput,
} from "./setup-fields.js";
import { promptReachableSignalServerUrl } from "./setup-server-probe.js";

export {
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  resolveSignalSetupTransportFromCredentialValues,
  signalSetupAdapter,
  type SignalSetupTransport,
} from "./setup-config.js";
export {
  createSignalCliPathTextInput,
  signalDmPolicy,
  signalNumberTextInput,
} from "./setup-fields.js";
export { setSignalSetupServerProbeForTest } from "./setup-server-probe.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const SIGNAL_STATUS_PROBE_COMMAND = formatCliCommand("openclaw channels status --probe");

function quoteSignalCliCommandArg(value: string): string {
  const safePattern =
    process.platform === "win32" ? /^[A-Za-z0-9_./:@%+=,~\\-]+$/u : /^[A-Za-z0-9_./:@%+=,~-]+$/u;
  if (safePattern.test(value)) {
    return value;
  }
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  if (value.startsWith("~/")) {
    return `~/${quoteSignalCliCommandArg(value.slice(2))}`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatSignalCliLinkCommand(params: { cliPath?: string; configPath?: string }): string {
  const args = [params.cliPath ?? "signal-cli"];
  if (params.configPath) {
    args.push("--config", params.configPath);
  }
  args.push("link", "-n", "OpenClaw");
  return args.map(quoteSignalCliCommandArg).join(" ");
}

async function showSignalNativeCompletionNote(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<void> {
  const account = resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config;
  const command = formatSignalCliLinkCommand({
    cliPath: normalizeOptionalString(account.cliPath),
    configPath: normalizeOptionalString(account.configPath),
  });
  await params.prompter.note(
    [
      "Signal uses a real Signal account/device, not a Telegram-style token bot account.",
      "Use a dedicated Signal number for bot-like operation when possible.",
      t("wizard.signal.nextLinkDevice", { command }),
      t("wizard.signal.nextScanQr"),
      `Then run: ${SIGNAL_STATUS_PROBE_COMMAND}`,
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ].join("\n"),
    t("wizard.signal.nextStepsTitle"),
  );
}

export async function prepareSignalSetupWizard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  runtime: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["runtime"];
  prompter: WizardPrompter;
  options?: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["options"];
}) {
  await params.prompter.note(
    [
      "Signal uses a real Signal account with a phone number, not a bot token.",
      "",
      "It is usually best to give OpenClaw its own Signal account and phone number. That keeps OpenClaw messages separate from your personal Signal messages.",
    ].join("\n"),
    "Signal",
  );
  let initialValue = resolveSignalSetupChoiceFromConfig(params);
  const baseCredentialValues: Record<string, string | undefined> = {
    ...params.credentialValues,
  };

  while (true) {
    const transport = await params.prompter.select<SignalSetupTransport>({
      message: "How do you want to set up Signal for OpenClaw?",
      initialValue,
      options: [
        {
          value: "native",
          label: "Use local signal-cli",
          hint: "OpenClaw starts the local signal-cli daemon for this account.",
        },
        {
          value: "external-native",
          label: "Connect to an existing Signal server",
          hint: "OpenClaw stores the URL and auto-detects the server protocol.",
        },
      ],
    });

    const account = resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId });
    const scopedNativeSetup =
      transport === "native" &&
      (params.accountId !== DEFAULT_ACCOUNT_ID ||
        shouldScopeDefaultSignalSetupPatch({
          cfg: params.cfg,
          accountId: params.accountId,
        }));
    const preferredPort = resolveSignalNativeSetupPreferredPort({
      cfg: params.cfg,
      accountId: params.accountId,
      existingAccount: account.config,
    });
    const nativeHttpPort = scopedNativeSetup
      ? resolveSignalNativeSetupHttpPort({
          cfg: params.cfg,
          accountId: params.accountId,
          preferredPort,
        })
      : undefined;
    const credentialValues: Record<string, string | undefined> = {
      ...baseCredentialValues,
      [SIGNAL_SETUP_TRANSPORT_KEY]: transport,
      ...(nativeHttpPort ? { [SIGNAL_SETUP_NATIVE_PORT_KEY]: String(nativeHttpPort) } : {}),
    };

    if (transport !== "native" || !params.options?.allowSignalInstall) {
      return { credentialValues };
    }

    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
      "signal-cli";
    const { detectBinary } = await import("openclaw/plugin-sdk/setup-tools");
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await params.prompter.confirm({
      message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return { credentialValues };
    }
    try {
      await params.options?.beforePersistentEffect?.();
      const { installSignalCli } = await import("./install-signal-cli.js");
      const result = await installSignalCli(params.runtime);
      if (result.ok && result.cliPath) {
        await params.prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        return {
          credentialValues: {
            ...credentialValues,
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await params.prompter.note(result.error ?? "signal-cli install failed.", "Signal");
      }
    } catch (error) {
      await params.prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
    }
    initialValue = "native";
  }
}

export async function finalizeSignalSetupWizard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  prompter: WizardPrompter;
}) {
  const transport = resolveSignalSetupTransportFromCredentialValues(params);
  let next = params.cfg;
  if (transport === "native") {
    const existingAccount = resolveSignalAccount({ cfg: next, accountId: params.accountId }).config;
    const existingConfigPath = normalizeOptionalString(existingAccount.configPath);
    const account =
      normalizeSignalAccountInput(params.credentialValues.signalNumber) ??
      normalizeOptionalString(existingAccount.account);
    if (!account) {
      await params.prompter.note(
        "Signal setup was not saved. Enter a Signal phone number before saving setup.",
        "Signal account",
      );
      return { cancelled: true as const };
    }
    await params.prompter.note(
      [
        "Optional. This is the folder where signal-cli stores its local account data.",
        "Leave it blank unless you use a custom signal-cli data directory.",
        "Example: ~/.local/share/signal-cli",
      ].join("\n"),
      "signal-cli config path",
    );
    const configPath = normalizeOptionalString(
      await params.prompter.text({
        message: "signal-cli config path (optional)",
        initialValue: existingConfigPath,
        placeholder: "~/.local/share/signal-cli",
      }),
    );
    const scopeDefaultToAccount = shouldScopeDefaultSignalSetupPatch({
      cfg: next,
      accountId: params.accountId,
    });
    const nativeHttpPortValue = Number(params.credentialValues[SIGNAL_SETUP_NATIVE_PORT_KEY]);
    const nativeHttpPort =
      Number.isSafeInteger(nativeHttpPortValue) && nativeHttpPortValue > 0
        ? nativeHttpPortValue
        : params.accountId !== DEFAULT_ACCOUNT_ID || scopeDefaultToAccount
          ? resolveSignalNativeSetupHttpPort({
              cfg: next,
              accountId: params.accountId,
              preferredPort: resolveSignalNativeSetupPreferredPort({
                cfg: next,
                accountId: params.accountId,
                existingAccount,
              }),
            })
          : undefined;
    next = patchSignalSetupConfigForAccount({
      cfg: next,
      accountId: params.accountId,
      patch: buildNativeSignalSetupPatch({
        accountId: params.accountId,
        scopeDefaultToAccount,
        existingApiMode: existingAccount.apiMode,
        existingAutoStart: existingAccount.autoStart,
        existingHttpHost: normalizeOptionalString(existingAccount.httpHost),
        existingHttpPort: existingAccount.httpPort,
        existingHttpUrl: normalizeOptionalString(existingAccount.httpUrl),
        account,
        cliPath:
          normalizeOptionalString(params.credentialValues.cliPath) ??
          normalizeOptionalString(existingAccount.cliPath),
        configPath,
        nativeHttpPort,
      }),
    });
    await showSignalNativeCompletionNote({
      cfg: next,
      accountId: params.accountId,
      prompter: params.prompter,
    });
    return { cfg: next };
  }

  await params.prompter.note(
    [
      "Use the HTTP URL for the Signal helper OpenClaw should talk to.",
      "For a local helper, this usually looks like http://127.0.0.1:8080.",
      "Setup checks native servers for daemon/RPC reachability. Container servers are also checked for a linked account and receive endpoint readiness.",
    ].join("\n"),
    "Signal server URL",
  );
  const resolvedAccount = resolveSignalAccount({ cfg: next, accountId: params.accountId });
  const credentialAccount = normalizeSignalAccountInput(params.credentialValues.signalNumber);
  const existingAccountValue = normalizeOptionalString(resolvedAccount.config.account);
  const existingAccount = normalizeSignalAccountInput(existingAccountValue);
  let account = normalizeSignalAccountInput(
    await params.prompter.text({
      message: "Signal phone number",
      initialValue: credentialAccount ?? existingAccount ?? undefined,
      placeholder: SIGNAL_PHONE_NUMBER_EXAMPLE,
      validate: (value) =>
        !normalizeOptionalString(value) || normalizeSignalAccountInput(value)
          ? undefined
          : `Enter a Signal phone number in international format, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
    }),
  );
  let server = await promptReachableSignalServerUrl({
    prompter: params.prompter,
    title: "Signal server URL",
    message: "Signal server URL",
    initialValue:
      normalizeOptionalString(resolvedAccount.config.httpUrl) ?? resolvedAccount.baseUrl,
    placeholder: "http://127.0.0.1:8080",
    account: account ?? "",
    apiMode: "auto",
  });
  if (!server) {
    await params.prompter.note(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    return { cancelled: true as const };
  }
  while (server.accountRequired) {
    account = normalizeSignalAccountInput(
      await params.prompter.text({
        message: "Signal phone number",
        initialValue: account ?? undefined,
        placeholder: SIGNAL_PHONE_NUMBER_EXAMPLE,
        validate: (value) =>
          normalizeSignalAccountInput(value)
            ? undefined
            : `Enter a Signal phone number in international format, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
      }),
    );
    if (!account) {
      return { cancelled: true as const };
    }
    server = await promptReachableSignalServerUrl({
      prompter: params.prompter,
      title: "Signal server URL",
      message: "Signal server URL",
      initialValue: server.httpUrl,
      placeholder: "http://127.0.0.1:8080",
      account,
      apiMode: "auto",
    });
    if (!server) {
      return { cancelled: true as const };
    }
  }
  next = patchSignalSetupConfigForAccount({
    cfg: next,
    accountId: params.accountId,
    patch: {
      ...(account ? { account } : existingAccountValue ? { account: "" } : {}),
      httpUrl: server.httpUrl,
      autoStart: false,
      apiMode: "auto",
    },
  });
  await params.prompter.note(
    [
      account ? `Signal server connected for ${account}.` : "Signal server connected.",
      account
        ? "Link and manage this account through the selected Signal server."
        : "Link and manage Signal accounts through the selected Signal server.",
      `Then run: ${SIGNAL_STATUS_PROBE_COMMAND}`,
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ].join("\n"),
    t("wizard.signal.nextStepsTitle"),
  );
  return { cfg: next };
}

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
      configuredHint: t("wizard.channels.statusSignalCliFound"),
      unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
      configuredScore: 1,
      unconfiguredScore: 0,
    },
    delegatePrepare: true,
    delegateFinalize: true,
    credentials: [],
    textInputs: [
      createSignalCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          loadWizard,
          inputKey: "cliPath",
        }),
      ),
      signalNumberTextInput,
    ],
    dmPolicy: signalDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  });
}
