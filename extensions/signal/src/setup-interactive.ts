import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import {
  patchChannelConfigForAccount,
  WizardCancelledError,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { installSignalCli } from "./install-signal-cli.js";
import { normalizeSignalAccountInput } from "./setup-core.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

const SIGNAL_TRANSPORT_KIND_KEY = "signalTransportKind";
const SIGNAL_CLI_PATH_KEY = "signalCliPath";
const SIGNAL_CLI_CONFIG_PATH_KEY = "signalCliConfigPath";
const SIGNAL_SERVER_URL_KEY = "signalServerUrl";

type SignalSetupMode = "local" | "existing-server";
type SignalPrepareParams = Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0];
type SignalFinalizeParams = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0];
type SignalExistingTransport = Extract<
  SignalTransportConfig,
  { kind: "external-native" | "container" }
>;
type ExistingServerPromptParams = {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
  initialValue?: string;
};

function normalizeEndpointHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .replace(/%.+$/, "");
}

function normalizeEndpointAddress(value: string): string {
  const normalized = normalizeEndpointHostname(value);
  return isIP(normalized) === 4 && normalized.startsWith("127.") ? "127.0.0.1" : normalized;
}

function endpointPort(url: URL): number {
  return url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
}

function localInterfaceAddresses(): Set<string> {
  const addresses = new Set(["127.0.0.1", "::1"]);
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        addresses.add(normalizeEndpointAddress(entry.address));
      }
    }
  } catch {
    // Some restricted environments deny interface enumeration; loopback aliases still work.
  }
  return addresses;
}

function resolveEndpointAddresses(endpointHostname: string): Set<string> {
  const normalized = normalizeEndpointHostname(endpointHostname);
  const localAddresses = localInterfaceAddresses();
  if (normalized === "0.0.0.0" || normalized === "::") {
    return localAddresses;
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return new Set(["127.0.0.1", "::1"]);
  }
  const localHostname = normalizeEndpointHostname(hostname());
  if (normalized === localHostname || normalized === `${localHostname}.local`) {
    return localAddresses;
  }
  return isIP(normalized) ? new Set([normalizeEndpointAddress(normalized)]) : new Set();
}

function matchesManagedSignalEndpoint(managedEndpoint: string, candidateEndpoint: string): boolean {
  try {
    const managed = new URL(managedEndpoint);
    const candidate = new URL(candidateEndpoint);
    if (managed.origin === candidate.origin) {
      return true;
    }
    if (
      managed.protocol !== candidate.protocol ||
      endpointPort(managed) !== endpointPort(candidate)
    ) {
      return false;
    }
    const managedAddresses = resolveEndpointAddresses(managed.hostname);
    const candidateAddresses = resolveEndpointAddresses(candidate.hostname);
    return [...managedAddresses].some((address) => candidateAddresses.has(address));
  } catch {
    return false;
  }
}

function formatSignalEndpointHost(host: string): string {
  const normalized = normalizeEndpointHostname(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function listConfiguredManagedSignalEndpoints(cfg: OpenClawConfig): string[] {
  return listSignalAccountIds(cfg).flatMap((accountId) => {
    const account = resolveSignalAccount({ cfg, accountId });
    if (!account.configured || account.transport.kind !== "managed-native") {
      return [];
    }
    return Array.from(
      new Set([
        account.transport.baseUrl,
        `http://${formatSignalEndpointHost(account.transport.httpHost)}:${account.transport.httpPort}`,
      ]),
    );
  });
}

function aliasesManagedSignalEndpoint(cfg: OpenClawConfig, candidateUrl: string): boolean {
  return listConfiguredManagedSignalEndpoints(cfg).some((managedUrl) =>
    matchesManagedSignalEndpoint(managedUrl, candidateUrl),
  );
}

async function promptSignalAccount(params: SignalFinalizeParams) {
  const raw = await params.prompter.text({
    message: "Signal phone number",
    placeholder: "+15555550123",
    validate: (value) =>
      normalizeSignalAccountInput(value)
        ? undefined
        : "Enter a Signal phone number in international format, for example +15555550123.",
  });
  const account = normalizeSignalAccountInput(raw);
  if (!account) {
    throw new Error("Signal phone number is required.");
  }
  return account;
}

async function prepareManagedNativeSetup(params: SignalPrepareParams) {
  const resolvedTransport = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).transport;
  let cliPath =
    resolvedTransport.kind === "managed-native" ? resolvedTransport.cliPath : "signal-cli";
  const cliDetected = await detectBinary(cliPath);

  if (params.options?.allowSignalInstall) {
    const wantsInstall = await params.prompter.confirm({
      message: cliDetected ? "Reinstall signal-cli?" : "Install signal-cli?",
      initialValue: !cliDetected,
    });
    if (wantsInstall) {
      await params.options.beforePersistentEffect?.();
      try {
        const result = await installSignalCli(params.runtime);
        if (result.ok && result.cliPath) {
          cliPath = result.cliPath;
          await params.prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        } else {
          await params.prompter.note(result.error ?? "signal-cli install failed.", "Signal");
        }
      } catch (error) {
        await params.prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
      }
    }
  }

  if (!(await detectBinary(cliPath))) {
    cliPath =
      normalizeOptionalString(
        await params.prompter.text({
          message: "signal-cli path",
          initialValue: cliPath,
          validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
        }),
      ) ?? cliPath;
  }

  const existingConfigPath =
    resolvedTransport.kind === "managed-native" ? resolvedTransport.configPath : undefined;
  const configPath = normalizeOptionalString(
    await params.prompter.text({
      message: "signal-cli config path (optional)",
      initialValue: existingConfigPath,
      placeholder: "~/.local/share/signal-cli",
    }),
  );

  // Validate account-owned port allocation now, while keeping the candidate ephemeral until probe.
  prepareSignalManagedNativeTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    overrides: { cliPath, ...(configPath ? { configPath } : {}) },
  });

  return {
    credentialValues: {
      [SIGNAL_TRANSPORT_KIND_KEY]: "managed-native",
      [SIGNAL_CLI_PATH_KEY]: cliPath,
      ...(configPath ? { [SIGNAL_CLI_CONFIG_PATH_KEY]: configPath } : {}),
    },
  };
}

async function promptExistingSignalTransport(
  params: ExistingServerPromptParams,
): Promise<SignalExistingTransport> {
  let initialValue = params.initialValue ?? "http://127.0.0.1:8080";
  let url = initialValue;
  let promptForUrl = true;

  while (true) {
    if (promptForUrl) {
      url =
        normalizeOptionalString(
          await params.prompter.text({
            message: "Signal server URL",
            initialValue,
            placeholder: "http://127.0.0.1:8080",
            validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
          }),
        ) ?? initialValue;
    }

    const detection = await detectSignalTransport({ url }).then(
      (transport) => ({ ok: true as const, transport }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!detection.ok) {
      await params.prompter.note(
        `OpenClaw could not detect a working Signal server at ${url}.\nError: ${String(detection.error)}`,
        "Signal server URL",
      );
      const recovery = await params.prompter.select<"retry" | "url" | "stop">({
        message: "How should Signal server setup continue?",
        options: [
          { value: "retry", label: "Retry this Signal server URL" },
          { value: "url", label: "Try another Signal server URL" },
          { value: "stop", label: "Stop Signal setup" },
        ],
        initialValue: "retry",
      });
      if (recovery === "stop") {
        throw new WizardCancelledError("Signal setup stopped");
      }
      promptForUrl = recovery === "url";
      initialValue = url;
      continue;
    }

    const transport = detection.transport;
    if (transport.kind === "managed-native") {
      throw new Error("Signal transport detection returned a managed-native transport");
    }
    if (!aliasesManagedSignalEndpoint(params.cfg, transport.url)) {
      return transport;
    }

    await params.prompter.note(
      [
        "That URL is an OpenClaw-managed Signal daemon.",
        "It stops when its account switches away from local signal-cli.",
        "Enter the URL of an independently operated Signal server instead.",
      ].join("\n"),
      "Signal server URL",
    );
    const recovery = await params.prompter.select<"url" | "stop">({
      message: "How should Signal server setup continue?",
      options: [
        { value: "url", label: "Try another Signal server URL" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "url",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
    initialValue = url;
    promptForUrl = true;
  }
}

async function prepareExistingServerSetup(params: SignalPrepareParams) {
  const resolvedTransport = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).transport;
  const transport = await promptExistingSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    prompter: params.prompter,
    initialValue:
      resolvedTransport.kind === "external-native" || resolvedTransport.kind === "container"
        ? resolvedTransport.baseUrl
        : "http://127.0.0.1:8080",
  });
  return {
    credentialValues: {
      [SIGNAL_TRANSPORT_KIND_KEY]: transport.kind,
      [SIGNAL_SERVER_URL_KEY]: transport.url,
    },
  };
}

export async function prepareSignalInteractiveSetup(params: SignalPrepareParams) {
  const resolvedAccount = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const initialMode: SignalSetupMode =
    resolvedAccount.configured && resolvedAccount.transport.kind !== "managed-native"
      ? "existing-server"
      : "local";

  const mode = await params.prompter.select<SignalSetupMode>({
    message: "How do you want to set up Signal for OpenClaw?",
    initialValue: initialMode,
    options: [
      {
        value: "local",
        label: "Use local signal-cli",
        hint: "OpenClaw starts the local signal-cli daemon for this account.",
      },
      {
        value: "existing-server",
        label: "Connect to an existing Signal server",
        hint: "OpenClaw detects and stores the server protocol for this account.",
      },
    ],
  });

  if (mode === "local") {
    return await prepareManagedNativeSetup(params);
  }
  return await prepareExistingServerSetup(params);
}

export async function finalizeSignalInteractiveSetup(params: SignalFinalizeParams) {
  const kind = params.credentialValues[SIGNAL_TRANSPORT_KIND_KEY];
  let cfg = params.cfg;
  let account =
    normalizeSignalAccountInput(
      resolveSignalAccount({ cfg, accountId: params.accountId }).config.account,
    ) ?? undefined;
  let transport: SignalTransportConfig | undefined =
    kind === "managed-native"
      ? prepareSignalManagedNativeTransport({
          cfg,
          accountId: params.accountId,
          overrides: {
            cliPath: params.credentialValues[SIGNAL_CLI_PATH_KEY] ?? "signal-cli",
            ...(params.credentialValues[SIGNAL_CLI_CONFIG_PATH_KEY]
              ? { configPath: params.credentialValues[SIGNAL_CLI_CONFIG_PATH_KEY] }
              : {}),
          },
        })
      : kind === "external-native" || kind === "container"
        ? {
            kind,
            url: params.credentialValues[SIGNAL_SERVER_URL_KEY] ?? "",
          }
        : undefined;
  if (!transport || (transport.kind !== "managed-native" && !transport.url)) {
    throw new Error("Signal setup is missing its prepared transport candidate.");
  }
  if ((transport.kind === "managed-native" || transport.kind === "container") && !account) {
    account = await promptSignalAccount(params);
    cfg = patchChannelConfigForAccount({
      cfg,
      channel: "signal",
      accountId: params.accountId,
      patch: { account, accountUuid: undefined },
    });
  }

  while (true) {
    const probe = await probeSignalTransport({
      cfg,
      accountId: params.accountId,
      transport,
      account,
    }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (probe.ok) {
      break;
    }

    await params.prompter.note(
      `OpenClaw could not validate this Signal setup.\nError: ${probe.error ?? "Signal transport probe failed."}`,
      "Signal setup",
    );
    const recovery = await params.prompter.select<"retry" | "account" | "url" | "stop">({
      message: "How should Signal setup continue?",
      options: [
        { value: "retry", label: "Retry this setup" },
        { value: "account", label: "Try another Signal account" },
        ...(transport.kind === "managed-native"
          ? []
          : [{ value: "url" as const, label: "Try another Signal server URL" }]),
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "retry",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
    if (recovery === "account") {
      account = await promptSignalAccount(params);
      cfg = patchChannelConfigForAccount({
        cfg,
        channel: "signal",
        accountId: params.accountId,
        patch: { account, accountUuid: undefined },
      });
      continue;
    }
    if (recovery === "url" && transport.kind !== "managed-native") {
      transport = await promptExistingSignalTransport({
        cfg,
        accountId: params.accountId,
        prompter: params.prompter,
        initialValue: transport.url,
      });
      if (transport.kind === "container" && !account) {
        account = await promptSignalAccount(params);
        cfg = patchChannelConfigForAccount({
          cfg,
          channel: "signal",
          accountId: params.accountId,
          patch: { account, accountUuid: undefined },
        });
      }
    }
  }

  return {
    cfg: writeSignalAccountTransport({
      cfg,
      accountId: params.accountId,
      transport,
    }),
  };
}
