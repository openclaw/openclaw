import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { ChannelSetupWizard, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import type { ResolvedSignalTransport } from "./accounts.js";
import { assertSignalDaemonBindAvailable, spawnSignalDaemon } from "./daemon.js";
import {
  probeSignalTransport,
  resolveConfiguredSignalTransport,
  type SignalTransportProbeResult,
} from "./setup-transport.js";
import { resolveSignalCliConfigPath } from "./signal-cli-config-path.js";
import { buildSignalTransportHttpUrl } from "./transport-url.js";

type SignalFinalizeParams = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0];

export type ManagedSignalTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;
export type ResolvedManagedSignalTransport = Extract<
  ResolvedSignalTransport,
  { kind: "managed-native" }
>;
export type LiveManagedTransportState =
  | "not-running"
  | "reuse-active-transport"
  | "validate-different-store";

function resolveExplicitSignalCliDataDirectory(configPath: string | undefined): string | undefined {
  const configured = normalizeOptionalString(configPath);
  if (!configured) {
    return undefined;
  }
  const absolute = path.resolve(resolveSignalCliConfigPath(configured));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

type SignalCliDataDirectoryRelationship = "same" | "different" | "unknown";

function compareSignalCliDataDirectories(
  active: ResolvedManagedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): SignalCliDataDirectoryRelationship {
  const activeDirectory = resolveExplicitSignalCliDataDirectory(active.configPath);
  const candidateDirectory = resolveExplicitSignalCliDataDirectory(candidate.configPath);
  if (!activeDirectory || !candidateDirectory) {
    // signal-cli can source its implicit dataDir from system or user config.
    // Two omitted paths share that resolution; one omitted path cannot be
    // proven distinct from an explicit store while the daemon owns its lock.
    return !activeDirectory && !candidateDirectory ? "same" : "unknown";
  }
  const same =
    process.platform === "win32"
      ? activeDirectory.toLowerCase() === candidateDirectory.toLowerCase()
      : activeDirectory === candidateDirectory;
  return same ? "same" : "different";
}

function isSameResolvedManagedBind(
  existing: ResolvedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): boolean {
  return (
    existing.kind === "managed-native" &&
    existing.httpHost === candidate.httpHost &&
    existing.httpPort === candidate.httpPort
  );
}

function isSameResolvedManagedTransport(
  existing: ResolvedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): boolean {
  if (existing.kind !== "managed-native") {
    return false;
  }
  return (
    isSameResolvedManagedBind(existing, candidate) &&
    existing.baseUrl === candidate.baseUrl &&
    existing.cliPath === candidate.cliPath &&
    compareSignalCliDataDirectories(existing, candidate) === "same" &&
    existing.startupTimeoutMs === candidate.startupTimeoutMs &&
    existing.receiveMode === candidate.receiveMode &&
    existing.ignoreStories === candidate.ignoreStories
  );
}

export async function evaluateLiveManagedTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: string | undefined;
  activeTransport: ResolvedSignalTransport;
  candidateTransport: ResolvedManagedSignalTransport;
}): Promise<LiveManagedTransportState> {
  const configuredTransport = resolveConfiguredSignalTransport(params.cfg, params.accountId);
  if (
    params.activeTransport.kind !== "managed-native" ||
    (!params.account && configuredTransport?.kind !== "managed-native")
  ) {
    return "not-running";
  }
  const existingTransport = configuredTransport ?? { kind: "managed-native" };
  const existingProbe = await probeSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    transport: existingTransport,
    ...(params.account ? { account: params.account } : {}),
    timeoutMs: 1_000,
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
  if (!existingProbe.ok) {
    return "not-running";
  }
  if (isSameResolvedManagedTransport(params.activeTransport, params.candidateTransport)) {
    if (!params.account) {
      throw new Error(
        "The running Signal daemon is using this signal-cli config directory. Stop the OpenClaw gateway before discovering or linking an account, then retry setup.",
      );
    }
    return "reuse-active-transport";
  }
  if (
    compareSignalCliDataDirectories(params.activeTransport, params.candidateTransport) !==
    "different"
  ) {
    throw new Error(
      "The running Signal daemon may be using this signal-cli config directory. Stop the OpenClaw gateway before changing its signal-cli settings, then retry setup.",
    );
  }
  return "validate-different-store";
}

export async function probeManagedSignalSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: ManagedSignalTransport;
  resolvedTransport: ResolvedManagedSignalTransport;
  account: string;
  runtime: SignalFinalizeParams["runtime"];
  prompter: WizardPrompter;
  useTemporaryPort: boolean;
  abortSignal?: AbortSignal;
}): Promise<SignalTransportProbeResult> {
  const progress = params.prompter.progress("Validating Signal setup...");
  let transport = params.transport;
  let resolvedTransport = params.resolvedTransport;
  let daemon: ReturnType<typeof spawnSignalDaemon> | undefined;
  let successfulProbe: SignalTransportProbeResult | undefined;
  let result: SignalTransportProbeResult;
  try {
    if (params.useTemporaryPort) {
      const httpPort = await allocateSignalValidationPort(resolvedTransport.httpHost);
      const baseUrl = buildSignalTransportHttpUrl(resolvedTransport.httpHost, httpPort);
      transport = { ...transport, httpPort, url: baseUrl };
      resolvedTransport = { ...resolvedTransport, httpPort, baseUrl };
    }
    const bindUrl = buildSignalTransportHttpUrl(
      resolvedTransport.httpHost,
      resolvedTransport.httpPort,
    );
    const bindTransport: ManagedSignalTransport = {
      ...transport,
      httpHost: resolvedTransport.httpHost,
      httpPort: resolvedTransport.httpPort,
      url: bindUrl,
    };
    if (!params.useTemporaryPort) {
      // A response from an existing process on this address must not be
      // mistaken for readiness of the daemon setup is about to spawn.
      await assertSignalDaemonBindAvailable({
        httpHost: resolvedTransport.httpHost,
        httpPort: resolvedTransport.httpPort,
      });
    }
    const spawnedDaemon = spawnSignalDaemon({
      cliPath: resolvedTransport.cliPath,
      ...(resolvedTransport.configPath ? { configPath: resolvedTransport.configPath } : {}),
      account: params.account,
      httpHost: resolvedTransport.httpHost,
      httpPort: resolvedTransport.httpPort,
      // Validation must not drain queued messages before the real monitor installs its handler.
      receiveMode: "manual",
      ...(typeof resolvedTransport.ignoreStories === "boolean"
        ? { ignoreStories: resolvedTransport.ignoreStories }
        : {}),
    });
    daemon = spawnedDaemon;
    const startupTimeoutMs = Math.min(120_000, Math.max(1_000, resolvedTransport.startupTimeoutMs));
    await waitForTransportReady({
      label: "signal-cli setup daemon",
      timeoutMs: startupTimeoutMs,
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      runtime: params.runtime,
      check: async () => {
        if (spawnedDaemon.isExited()) {
          throw new Error("signal-cli exited before its HTTP server became ready.");
        }
        const probe = await probeSignalTransport({
          cfg: params.cfg,
          accountId: params.accountId,
          transport: bindTransport,
          account: params.account,
          timeoutMs: 1_000,
        }).catch((error: unknown) => ({ ok: false, error: String(error) }));
        if (probe.ok) {
          successfulProbe = probe;
        }
        return probe;
      },
    });
    params.abortSignal?.throwIfAborted();
    result = successfulProbe ?? { ok: false, error: "Signal transport probe failed." };
    if (result.ok && resolvedTransport.baseUrl !== bindUrl) {
      result = await probeSignalTransport({
        cfg: params.cfg,
        accountId: params.accountId,
        transport,
        account: params.account,
        timeoutMs: 1_000,
      }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    }
  } catch (error) {
    if (params.abortSignal?.aborted) {
      throw params.abortSignal.reason;
    }
    result = { ok: false, error: String(error) };
  } finally {
    await daemon?.stop();
  }
  progress.stop(result.ok ? "Signal setup validated." : "Signal setup validation failed.");
  return result;
}

async function allocateSignalValidationPort(host: string): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not allocate a temporary Signal validation port.");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}
