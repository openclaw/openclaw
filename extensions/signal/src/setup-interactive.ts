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
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
  resolveSignalTransport,
  type ResolvedSignalTransport,
} from "./accounts.js";
import { spawnSignalDaemon } from "./daemon.js";
import { installSignalCli } from "./install-signal-cli.js";
import { normalizeSignalAccountInput, signalSetupStateKeys } from "./setup-core.js";
import { resolveManagedSignalAccount } from "./setup-managed-account.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  type SignalTransportProbeResult,
  writeSignalAccountTransport,
} from "./setup-transport.js";

type SignalSetupMode = "local" | "existing-server";
type SignalPrepareParams = Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0];
type SignalFinalizeParams = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0];
type SignalExistingTransport = Extract<
  SignalTransportConfig,
  { kind: "external-native" | "container" }
>;
type ExistingServerPromptParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  initialValue?: string;
};
type ManagedSignalTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;
type ResolvedManagedSignalTransport = Extract<ResolvedSignalTransport, { kind: "managed-native" }>;

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
    return await prepareManagedNativeSetup(params, resolvedAccount.transport);
  }
  return await prepareExistingServerSetup(params, resolvedAccount.transport);
}

export async function finalizeSignalInteractiveSetup(params: SignalFinalizeParams) {
  const kind = params.credentialValues[signalSetupStateKeys.transportKind];
  let cfg = params.cfg;
  const resolvedAccount = resolveSignalAccount({
    cfg,
    accountId: params.accountId,
  });
  let account = normalizeSignalAccountInput(resolvedAccount.config.account) ?? undefined;
  let transport: SignalTransportConfig;
  let resolvedManagedTransport: ResolvedManagedSignalTransport | undefined;
  if (kind === "managed-native") {
    let cliPath = params.credentialValues[signalSetupStateKeys.cliPath] ?? "signal-cli";
    if (
      params.options?.allowSignalInstall &&
      params.credentialValues[signalSetupStateKeys.installRequested] === "true"
    ) {
      cliPath = await installRequestedSignalCli(params, cliPath);
    }
    const configPath = params.credentialValues[signalSetupStateKeys.cliConfigPath];
    transport = prepareSignalManagedNativeTransport({
      cfg,
      accountId: params.accountId,
      overrides: {
        cliPath,
        ...(configPath ? { configPath } : {}),
      },
    });
  } else if (kind === "external-native" || kind === "container") {
    const url = params.credentialValues[signalSetupStateKeys.serverUrl];
    if (!url) {
      throw new Error("Signal setup is missing its prepared transport candidate.");
    }
    transport = { kind, url };
  } else {
    throw new Error("Signal setup is missing its prepared transport candidate.");
  }

  if (transport.kind === "managed-native") {
    const resolvedTransport = resolveSignalTransport(transport);
    if (resolvedTransport.kind !== "managed-native") {
      throw new Error("Signal setup did not resolve a managed signal-cli transport.");
    }
    resolvedManagedTransport = resolvedTransport;
    account = await resolveManagedSignalAccount({
      transport: resolvedTransport,
      configuredAccount: account,
      selectionMode: "reuse-configured-or-only",
      prompter: params.prompter,
      beforePersistentEffect: params.options?.beforePersistentEffect,
    });
    cfg = patchChannelConfigForAccount({
      cfg,
      channel: "signal",
      accountId: params.accountId,
      patch: { account, accountUuid: undefined },
    });
  }

  let shouldPromptAccount = !account && transport.kind !== "external-native";

  while (true) {
    // Account or URL recovery re-enters here so every probe sees matching candidate state.
    if (shouldPromptAccount) {
      account = await promptSignalAccount(params.prompter);
      cfg = patchChannelConfigForAccount({
        cfg,
        channel: "signal",
        accountId: params.accountId,
        patch: { account, accountUuid: undefined },
      });
      shouldPromptAccount = false;
    }

    const probe =
      transport.kind === "managed-native" && resolvedManagedTransport && account
        ? await probeManagedSignalSetup({
            cfg,
            accountId: params.accountId,
            transport,
            resolvedTransport: resolvedManagedTransport,
            account,
            runtime: params.runtime,
            prompter: params.prompter,
          })
        : await probeSignalTransport({
            cfg,
            accountId: params.accountId,
            transport,
            account,
          }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (probe.ok) {
      break;
    }

    await params.prompter.note(
      `OpenClaw could not validate this Signal setup.\n\n${probe.error ?? "Signal transport probe failed."}`,
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
      if (transport.kind === "managed-native" && resolvedManagedTransport) {
        account = await resolveManagedSignalAccount({
          transport: resolvedManagedTransport,
          selectionMode: "choose",
          prompter: params.prompter,
          beforePersistentEffect: params.options?.beforePersistentEffect,
        });
        cfg = patchChannelConfigForAccount({
          cfg,
          channel: "signal",
          accountId: params.accountId,
          patch: { account, accountUuid: undefined },
        });
      } else {
        shouldPromptAccount = true;
      }
      continue;
    }
    if (recovery === "url" && transport.kind !== "managed-native") {
      transport = await promptExistingSignalTransport({
        cfg,
        prompter: params.prompter,
        initialValue: transport.url,
      });
      shouldPromptAccount = !account && transport.kind !== "external-native";
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

async function probeManagedSignalSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: ManagedSignalTransport;
  resolvedTransport: ResolvedManagedSignalTransport;
  account: string;
  runtime: SignalFinalizeParams["runtime"];
  prompter: WizardPrompter;
}): Promise<SignalTransportProbeResult> {
  const progress = params.prompter.progress("Validating Signal setup...");
  const daemon = spawnSignalDaemon({
    cliPath: params.resolvedTransport.cliPath,
    ...(params.resolvedTransport.configPath
      ? { configPath: params.resolvedTransport.configPath }
      : {}),
    account: params.account,
    httpHost: params.resolvedTransport.httpHost,
    httpPort: params.resolvedTransport.httpPort,
  });
  let successfulProbe: SignalTransportProbeResult | undefined;
  let result: SignalTransportProbeResult;
  try {
    const startupTimeoutMs = Math.min(
      120_000,
      Math.max(1_000, params.resolvedTransport.startupTimeoutMs),
    );
    await waitForTransportReady({
      label: "signal-cli setup daemon",
      timeoutMs: startupTimeoutMs,
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      runtime: params.runtime,
      check: async () => {
        if (daemon.isExited()) {
          throw new Error("signal-cli exited before its HTTP server became ready.");
        }
        const probe = await probeSignalTransport({
          cfg: params.cfg,
          accountId: params.accountId,
          transport: params.transport,
          account: params.account,
          timeoutMs: 1_000,
        }).catch((error: unknown) => ({ ok: false, error: String(error) }));
        if (probe.ok) {
          successfulProbe = probe;
        }
        return probe;
      },
    });
    result = successfulProbe ?? { ok: false, error: "Signal transport probe failed." };
  } catch (error) {
    result = { ok: false, error: String(error) };
  } finally {
    await daemon.stop();
  }
  progress.stop(result.ok ? "Signal setup validated." : "Signal setup validation failed.");
  return result;
}

async function promptSignalAccount(prompter: WizardPrompter) {
  const raw = await prompter.text({
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

async function installRequestedSignalCli(params: SignalFinalizeParams, initialCliPath: string) {
  await params.options?.beforePersistentEffect?.();

  let cliPath = initialCliPath;
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

  if (await detectBinary(cliPath)) {
    return cliPath;
  }
  return (
    normalizeOptionalString(
      await params.prompter.text({
        message: "signal-cli path",
        initialValue: cliPath,
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    ) ?? cliPath
  );
}

async function prepareManagedNativeSetup(
  params: SignalPrepareParams,
  resolvedTransport: ResolvedSignalTransport,
) {
  let cliPath =
    resolvedTransport.kind === "managed-native" ? resolvedTransport.cliPath : "signal-cli";
  const cliDetected = await detectBinary(cliPath);
  let installRequested = false;

  if (params.options?.allowSignalInstall) {
    installRequested = await params.prompter.confirm({
      message: cliDetected ? "Reinstall signal-cli? (not normally needed)" : "Install signal-cli?",
      initialValue: !cliDetected,
    });
  }

  if (!cliDetected && !installRequested) {
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
      message: "signal-cli config directory (leave blank for default)",
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
      [signalSetupStateKeys.transportKind]: "managed-native",
      [signalSetupStateKeys.cliPath]: cliPath,
      ...(configPath ? { [signalSetupStateKeys.cliConfigPath]: configPath } : {}),
      ...(installRequested ? { [signalSetupStateKeys.installRequested]: "true" } : {}),
    },
  };
}

async function promptSignalServerUrl(prompter: WizardPrompter, initialValue: string) {
  return (
    normalizeOptionalString(
      await prompter.text({
        message: "Signal server URL",
        initialValue,
        placeholder: "http://127.0.0.1:8080",
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    ) ?? initialValue
  );
}

async function promptExistingSignalTransport(
  params: ExistingServerPromptParams,
): Promise<SignalExistingTransport> {
  let url = await promptSignalServerUrl(
    params.prompter,
    params.initialValue ?? "http://127.0.0.1:8080",
  );
  while (true) {
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
      if (recovery === "url") {
        url = await promptSignalServerUrl(params.prompter, url);
      }
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
    url = await promptSignalServerUrl(params.prompter, url);
  }
}

async function prepareExistingServerSetup(
  params: SignalPrepareParams,
  resolvedTransport: ResolvedSignalTransport,
) {
  const transport = await promptExistingSignalTransport({
    cfg: params.cfg,
    prompter: params.prompter,
    initialValue:
      resolvedTransport.kind === "external-native" || resolvedTransport.kind === "container"
        ? resolvedTransport.baseUrl
        : "http://127.0.0.1:8080",
  });
  return {
    credentialValues: {
      [signalSetupStateKeys.transportKind]: transport.kind,
      [signalSetupStateKeys.serverUrl]: transport.url,
    },
  };
}

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
