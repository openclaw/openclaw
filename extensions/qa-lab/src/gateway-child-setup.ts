import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { SUPERVISOR_HINT_ENV_VARS } from "openclaw/plugin-sdk/process-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  createQaBundledPluginsDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaStagedBundledPluginsRoot,
} from "./bundled-plugin-staging.js";
import { buildQaCodexAppServerArgs } from "./codex-app-server-args.js";
import {
  resolveQaGatewayChildCommand,
  runQaGatewayCliCommand,
  type QaGatewayChildCommand,
} from "./gateway-child-command.js";
import { initializeQaGatewayChildState } from "./gateway-child-initializer.js";
import type { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { createQaGatewayChildLogCollector } from "./gateway-child-process.js";
import { createQaGatewayCliError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import { reserveQaGatewayPort } from "./gateway-port-reservation.js";
import { createQaGatewayProcessBoundaryController } from "./gateway-process-boundary.js";
import { splitQaModelRef, type QaProviderMode } from "./model-selection.js";
import {
  normalizeQaProviderModeEnv,
  resolveQaLiveCliAuthEnv,
  type QaCliBackendAuthMode,
} from "./providers/env.js";
import { DEFAULT_QA_PROVIDER_MODE, getQaProvider } from "./providers/index.js";
import { readQaLiveProviderConfigOverrides } from "./providers/live-config.js";
import {
  QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV,
  QA_LIVE_SETUP_TOKEN_VALUE_ENV,
  assertQaLiveCodexAuthAvailable,
  stageQaLiveApiKeyProfiles,
  stageQaLiveAnthropicSetupToken,
} from "./providers/live-frontier/auth.js";
import {
  applyQaMockAuthProfileConfig,
  buildQaMockProfileId,
  stageQaMockAuthProfiles,
} from "./providers/shared/mock-auth.js";
import { listMockCodexModelInfos } from "./providers/shared/mock-model-config.js";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig, type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { QaRuntimeSelection, RuntimeId } from "./runtime-id.js";
export type QaGatewayChildStateMutationContext = {
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  stateDir: string;
  tempRoot: string;
};

export type QaGatewayChildListeningContext = {
  attempt: number;
  baseUrl: string;
  wsUrl: string;
  token: string;
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  logs: () => string;
};

export type QaGatewayChildParams = {
  repoRoot: string;
  command?: QaGatewayChildCommand;
  useRepoCli?: boolean;
  /** Fresh current-repository fixture; released-package upgrade tests keep repair. */
  initializeCurrentRuntimeState?: boolean;
  providerBaseUrl?: string;
  mockSessionObserverUrl?: string;
  transport?: Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  forcedRuntime?: RuntimeId;
  runtimeSelection?: QaRuntimeSelection;
  codexMockAutoCompactTokenLimit?: number;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  enabledPluginIds?: string[];
  allowUnhealthyStartup?: boolean;
  forwardHostHome?: boolean;
  mockAuthAgentIds?: readonly string[];
  onListening?: (context: QaGatewayChildListeningContext) => Promise<void> | void;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
  runtimeEnvPatch?: NodeJS.ProcessEnv;
  runtimePreloads?: readonly string[];
};

const OPENCLAW_QA_CODEX_API_KEY_HANDOFF = "OPENCLAW_QA_CODEX_API_KEY_HANDOFF";

const QA_GATEWAY_CHILD_BLOCKED_ENV_VARS: readonly string[] = [
  // QA owns this child; parent service and test-runner markers describe a different process.
  ...SUPERVISOR_HINT_ENV_VARS,
  "VITEST",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "BASH_ENV",
  "BASHOPTS",
  "ENV",
  OPENCLAW_QA_CODEX_API_KEY_HANDOFF,
  "OPENCLAW_QA_CONVEX_SECRET_CI",
  "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER",
  "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL",
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
  "SHELLOPTS",
];

function resolveQaControlUiRoot(params: { repoRoot: string; controlUiEnabled?: boolean }) {
  if (params.controlUiEnabled === false) {
    return undefined;
  }
  const controlUiRoot = path.join(params.repoRoot, "dist", "control-ui");
  const indexPath = path.join(controlUiRoot, "index.html");
  return existsSync(indexPath) ? controlUiRoot : undefined;
}

async function runQaPackagedBootstrap<T>(
  failureMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const details = createQaGatewayCliError(error).message;
    // oxlint-disable-next-line preserve-caught-error -- Candidate CLI output can contain credentials; only the bounded redacted message crosses this boundary, never its raw cause.
    throw new Error(`${failureMessage}: ${details}`);
  }
}

function createQaPackagedBootstrapEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bootstrapEnv = { ...env };
  const gatewayOnlyKeys = new Set([
    "OPENCLAW_BUILD_PRIVATE_QA",
    "OPENCLAW_ENABLE_PRIVATE_QA_CLI",
    "NODE_OPTIONS",
  ]);
  for (const envKey of Object.keys(bootstrapEnv)) {
    if (gatewayOnlyKeys.has(envKey.toUpperCase())) {
      delete bootstrapEnv[envKey];
    }
  }
  return bootstrapEnv;
}

export async function prepareQaGatewayChild(
  params: QaGatewayChildParams,
  lifetime: QaGatewayChildLifecycle,
) {
  const tempParentDir = params.command?.tempParentDir ?? resolvePreferredOpenClawTmpDir();
  lifetime.tempRoot = await fs.mkdtemp(path.join(tempParentDir, "openclaw-qa-suite-"));
  // Store discovery returns physical paths; macOS /tmp aliases must not split
  // the fixture's configured roots from their captured database custody.
  const tempRoot = await fs.realpath(lifetime.tempRoot);
  lifetime.tempRoot = tempRoot;
  const runtimeCwd = tempRoot;
  const distEntryPath = path.join(params.repoRoot, "dist", "index.js");
  const gatewayCommand =
    params.command ??
    (params.useRepoCli ? resolveQaGatewayChildCommand(params.repoRoot) : undefined);
  const usesPackagedCandidate = gatewayCommand?.usePackagedPlugins === true;
  const gatewayExecutablePath = gatewayCommand?.executablePath;
  const gatewayArgsPrefix = gatewayCommand?.argsPrefix ?? [];
  const gatewayArgsSuffix = gatewayCommand?.argsSuffix ?? [];
  const runtimePreloadArgs = (params.runtimePreloads ?? []).flatMap((specifier) => [
    "--import",
    specifier,
  ]);
  const gatewayCwd = gatewayCommand?.cwd ?? runtimeCwd;
  const workspaceDir = path.join(tempRoot, "workspace");
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const xdgConfigHome = path.join(tempRoot, "xdg-config");
  const xdgDataHome = path.join(tempRoot, "xdg-data");
  const xdgCacheHome = path.join(tempRoot, "xdg-cache");
  const configPath = path.join(tempRoot, "openclaw.json");
  const packagedAuthConfigPath = path.join(stateDir, "qa-auth-bootstrap", "openclaw.json");
  const gatewayToken = `qa-suite-${randomUUID()}`;
  const transport = params.transport;
  await seedQaAgentWorkspace({
    workspaceDir,
    repoRoot: params.repoRoot,
  });
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
    fs.mkdir(xdgConfigHome, { recursive: true }),
    fs.mkdir(xdgDataHome, { recursive: true }),
    fs.mkdir(xdgCacheHome, { recursive: true }),
  ]);
  const providerMode = params.providerMode ?? DEFAULT_QA_PROVIDER_MODE;
  const codexModelCatalogPath = path.join(tempRoot, "codex-model-catalog.json");
  if (params.forcedRuntime === "codex" && providerMode === "mock-openai") {
    const selectedModelRefs = [params.primaryModel, params.alternateModel].filter(
      (model): model is string => typeof model === "string" && model.length > 0,
    );
    const models = listMockCodexModelInfos(selectedModelRefs);
    if (params.codexMockAutoCompactTokenLimit !== undefined) {
      for (const model of models) {
        Object.assign(model, { auto_compact_token_limit: params.codexMockAutoCompactTokenLimit });
      }
    }
    await fs.writeFile(codexModelCatalogPath, `${JSON.stringify({ models }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const resolvedProvider = getQaProvider(providerMode);
  const liveProviderIds =
    resolvedProvider.kind === "live"
      ? [params.primaryModel, params.alternateModel]
          .map((modelRef) =>
            typeof modelRef === "string" ? splitQaModelRef(modelRef)?.provider : undefined,
          )
          .filter((providerId): providerId is string => Boolean(providerId))
      : [];
  const liveProviderConfigs = await readQaLiveProviderConfigOverrides({
    providerIds: liveProviderIds,
  });
  const liveOwnerPluginIds =
    liveProviderIds.length > 0
      ? await resolveQaOwnerPluginIdsForProviderIds({
          repoRoot: params.repoRoot,
          providerIds: liveProviderIds,
          providerConfigs: liveProviderConfigs,
        })
      : [];
  const enabledPluginIds = uniqueStrings([
    ...liveOwnerPluginIds,
    ...(params.enabledPluginIds ?? []),
  ]);
  const buildGatewayConfig = (gatewayPort: number) =>
    buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort,
      gatewayToken,
      // This is a fresh fixture, not config previously written by the tooling
      // runtime. Let the packaged candidate's required repair stamp its version
      // instead of making older release candidates appear to be downgrades.
      stampCurrentVersion: !usesPackagedCandidate,
      providerBaseUrl: params.providerBaseUrl,
      mockSessionObserverUrl: params.mockSessionObserverUrl,
      workspaceDir,
      controlUiRoot: resolveQaControlUiRoot({
        repoRoot: params.repoRoot,
        controlUiEnabled: params.controlUiEnabled,
      }),
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      enabledPluginIds,
      transportPluginIds: transport?.requiredPluginIds ?? [],
      transportConfig:
        transport?.createGatewayConfig({
          baseUrl: params.transportBaseUrl,
        }) ?? {},
      liveProviderConfigs,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      forcedRuntime: params.forcedRuntime,
      runtimeSelection: params.runtimeSelection,
      controlUiEnabled: params.controlUiEnabled,
    });
  const buildStagedGatewayConfig = async (gatewayPort: number) => {
    let cfg = buildGatewayConfig(gatewayPort);
    cfg = await stageQaLiveApiKeyProfiles({
      cfg,
      stateDir,
      providerIds: liveProviderIds,
    });
    cfg = await stageQaLiveAnthropicSetupToken({
      cfg,
      stateDir,
    });
    const mockAuthProviders = resolvedProvider.mockAuthProviders;
    if (mockAuthProviders && mockAuthProviders.length > 0) {
      if (usesPackagedCandidate) {
        cfg = applyQaMockAuthProfileConfig({ cfg, providers: mockAuthProviders });
      } else {
        cfg = await stageQaMockAuthProfiles({
          cfg,
          stateDir,
          agentIds: params.mockAuthAgentIds,
          providers: mockAuthProviders,
        });
      }
    }
    return params.mutateConfig ? params.mutateConfig(cfg) : cfg;
  };
  const output = createQaGatewayChildLogCollector();
  const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
  const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
  const stdoutLog = createWriteStream(stdoutLogPath, { flags: "a" });
  lifetime.logStreams.push(["stdout", stdoutLog]);
  const stderrLog = createWriteStream(stderrLogPath, { flags: "a" });
  lifetime.logStreams.push(["stderr", stderrLog]);

  const logs = () => redactQaGatewayDebugText(output.text());
  let gatewayPort = 0;
  let baseUrl = "";
  let wsUrl = "";
  let cfg!: OpenClawConfig;
  let env: NodeJS.ProcessEnv | null = null;

  const nodeExecPath = gatewayExecutablePath ?? process.execPath;
  const cliArgsPrefix = gatewayCommand?.processBoundary
    ? gatewayArgsPrefix
    : gatewayExecutablePath
      ? [...runtimePreloadArgs, ...gatewayArgsPrefix]
      : [...runtimePreloadArgs, distEntryPath, ...gatewayArgsPrefix];
  const buildGatewayArgs = () => [
    ...cliArgsPrefix,
    "gateway",
    "run",
    "--port",
    String(gatewayPort),
    "--bind",
    "loopback",
    "--allow-unconfigured",
    ...gatewayArgsSuffix,
  ];
  lifetime.controller = gatewayCommand?.processBoundary
    ? await createQaGatewayProcessBoundaryController({
        config: {
          ...gatewayCommand.processBoundary,
          runtimeArgsPrefix: [
            ...runtimePreloadArgs,
            ...gatewayCommand.processBoundary.runtimeArgsPrefix,
          ],
        },
        launcherPath: nodeExecPath,
        tempRoot,
      })
    : null;
  return {
    output,
    logs,
    stdoutLog,
    stderrLog,
    nodeExecPath,
    gatewayCwd,
    cliArgsPrefix,
    workspaceDir,
    stateDir,
    tempRoot,
    configPath,
    gatewayToken,
    buildGatewayArgs,
    async prepareAttempt() {
      lifetime.assertOpen();
      lifetime.portReservation = await reserveQaGatewayPort(net.createServer());
      gatewayPort = lifetime.portReservation.port;
      baseUrl = `http://127.0.0.1:${gatewayPort}`;
      wsUrl = `ws://127.0.0.1:${gatewayPort}`;
      cfg = await buildStagedGatewayConfig(gatewayPort);
      const allowedPluginIds = uniqueStrings(
        [...(cfg.plugins?.allow ?? []), "openai"].filter(
          (pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0,
        ),
      );
      if (!usesPackagedCandidate) {
        // Register the external root before staging so one lifecycle owner
        // also cleans partial copies and host-version resolution failures.
        lifetime.stagedBundledPluginsRoot = resolveQaStagedBundledPluginsRoot({
          repoRoot: params.repoRoot,
          tempRoot,
        });
      }
      const stagedPluginRuntime = usesPackagedCandidate
        ? { bundledPluginsDir: undefined, runtimeHostVersion: undefined }
        : await createQaBundledPluginsDir({
            repoRoot: params.repoRoot,
            tempRoot,
            allowedPluginIds,
          });
      let forcedRuntimeEnvPatch: NodeJS.ProcessEnv | undefined;
      if (params.forcedRuntime) {
        forcedRuntimeEnvPatch = {
          OPENCLAW_BUILD_PRIVATE_QA: "1",
          ...(params.runtimeSelection === "configured"
            ? {}
            : { OPENCLAW_QA_FORCE_RUNTIME: params.forcedRuntime }),
        };
        if (params.forcedRuntime === "codex") {
          if (providerMode !== "mock-openai") {
            forcedRuntimeEnvPatch.OPENCLAW_CODEX_APP_SERVER_ARGS = buildQaCodexAppServerArgs({
              existingArgs:
                params.runtimeEnvPatch?.OPENCLAW_CODEX_APP_SERVER_ARGS ??
                process.env.OPENCLAW_CODEX_APP_SERVER_ARGS,
            });
          } else {
            const providerBaseUrl = params.providerBaseUrl?.trim().replace(/\/+$/u, "");
            if (!providerBaseUrl) {
              throw new Error("forced Codex mock QA requires the managed mock provider URL");
            }
            forcedRuntimeEnvPatch.OPENCLAW_CODEX_APP_SERVER_ARGS = buildQaCodexAppServerArgs({
              providerBaseUrl,
              modelCatalogPath: codexModelCatalogPath,
            });
          }
        }
      }
      const baseEnv = process.env;
      const forwardedHostHome = params.forwardHostHome
        ? baseEnv.HOME?.trim() || os.homedir()
        : undefined;
      env = {
        ...baseEnv,
        HOME: forwardedHostHome ?? homeDir,
        ...(resolvedProvider.kind === "live"
          ? resolveQaLiveCliAuthEnv(baseEnv, {
              forwardHostHomeForClaudeCli: liveProviderIds.includes("claude-cli"),
              claudeCliAuthMode: params.claudeCliAuthMode,
            })
          : {}),
        OPENCLAW_HOME: homeDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: "2000",
        OPENCLAW_QA_TEMP_ROOT: tempRoot,
        ...(lifetime.stagedBundledPluginsRoot
          ? { OPENCLAW_QA_STAGED_RUNTIME_ROOT: lifetime.stagedBundledPluginsRoot }
          : {}),
        OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1",
        // QA uses the fast runtime envelope for speed, but it still exercises
        // normal config-driven heartbeats and runtime config writes.
        OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
        XDG_CACHE_HOME: xdgCacheHome,
        ...(stagedPluginRuntime.bundledPluginsDir
          ? { OPENCLAW_BUNDLED_PLUGINS_DIR: stagedPluginRuntime.bundledPluginsDir }
          : {}),
        ...(stagedPluginRuntime.runtimeHostVersion
          ? { OPENCLAW_COMPATIBILITY_HOST_VERSION: stagedPluginRuntime.runtimeHostVersion }
          : {}),
      };
      env = normalizeQaProviderModeEnv(env, providerMode);
      // Test-runner skip flags are parent controls; each QA child declares its own runtime needs.
      delete env.OPENCLAW_SKIP_CHANNELS;
      delete env.OPENCLAW_SKIP_PROVIDERS;
      delete env.OPENCLAW_SKIP_CRON;
      Object.assign(env, params.runtimeEnvPatch, forcedRuntimeEnvPatch);
      const codexApiKeyHandoff =
        providerMode === "live-frontier"
          ? env[OPENCLAW_QA_CODEX_API_KEY_HANDOFF]?.trim()
          : undefined;
      if (codexApiKeyHandoff && !env.CODEX_API_KEY?.trim()) {
        env.CODEX_API_KEY = codexApiKeyHandoff;
      }
      // Child scratch and default compiler caches share the Gateway's joined cleanup lifetime.
      env.TMPDIR = tempRoot;
      env.TMP = tempRoot;
      env.TEMP = tempRoot;
      // Path isolation alone still lets CLI bootstrap discover the operator's service.
      env.OPENCLAW_PROFILE = `qa-${createHash("sha256")
        .update(tempRoot)
        .digest("hex")
        .slice(0, 24)}`;
      if (usesPackagedCandidate) {
        delete env.OPENCLAW_DEV_SOURCE_ROOT;
      } else {
        env.OPENCLAW_DEV_SOURCE_ROOT = params.repoRoot;
      }
      // Direct Gateway launches need the same private-QA build and SDK admission
      // as the QA CLI; caller patches cannot disable either half of that contract.
      env.OPENCLAW_BUILD_PRIVATE_QA = "1";
      env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
      env.OPENCLAW_GATEWAY_HOST_LIFELINE = "stdin";
      // Parent shell startup controls must be removed after caller patches so no
      // launcher or runtime child can import them before its own allowlist runs.
      delete env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV];
      delete env[QA_LIVE_SETUP_TOKEN_VALUE_ENV];
      for (const envKey of QA_GATEWAY_CHILD_BLOCKED_ENV_VARS) {
        delete env[envKey];
      }
      // Bash imports exported functions before the launcher can apply its allowlist.
      for (const envKey of Object.keys(env)) {
        if (envKey.startsWith("BASH_FUNC_")) {
          delete env[envKey];
        }
      }
      if (env.NODE_ENV === "test") {
        delete env.NODE_ENV;
      }
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: liveProviderIds,
        env,
      });
      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      // Bootstrap commands must inspect this child's port without our placeholder listener.
      env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
      await lifetime.portReservation?.release();
      lifetime.portReservation = null;
      const mockAuthProviders = resolvedProvider.mockAuthProviders;
      if (usesPackagedCandidate && gatewayCommand && mockAuthProviders?.length) {
        const canonicalConfig = await fs.readFile(configPath);
        await fs.mkdir(path.dirname(packagedAuthConfigPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(packagedAuthConfigPath, canonicalConfig, {
          flag: "wx",
          mode: 0o600,
        });
        const bootstrapEnv = createQaPackagedBootstrapEnv(env);
        for (const provider of uniqueStrings(mockAuthProviders)) {
          await runQaPackagedBootstrap(
            `installed package mock auth bootstrap failed for ${provider}`,
            () => {
              const prefix = ["s", "k"].join("");
              return runQaGatewayCliCommand({
                lifetime,
                executablePath: gatewayCommand.executablePath,
                argsPrefix: gatewayCommand.argsPrefix ?? [],
                args: [
                  "models",
                  "auth",
                  "--agent",
                  "qa",
                  "paste-api-key",
                  "--provider",
                  provider,
                  "--profile-id",
                  buildQaMockProfileId(provider),
                ],
                cwd: gatewayCommand.cwd ?? gatewayCwd,
                env: { ...bootstrapEnv, OPENCLAW_CONFIG_PATH: packagedAuthConfigPath },
                stdin: `${prefix}-${["qa", "mock", randomUUID().replaceAll("-", "")].join("-")}\n`,
                bootstrapPhase: "mock-auth",
              });
            },
          );
        }
        if (!canonicalConfig.equals(await fs.readFile(configPath))) {
          throw new Error("installed package mock auth bootstrap mutated canonical config");
        }
      }
      // Auth staging opens parent-owned agent stores. Release this fixture's
      // leases before packaged repair or Gateway startup takes maintenance ownership.
      await closeQaRuntimeStores(tempRoot);
      lifetime.assertOpen();

      if (params.initializeCurrentRuntimeState) {
        const bootstrapEnv = createQaPackagedBootstrapEnv(env);
        await runQaPackagedBootstrap("QA state initialization failed", () =>
          initializeQaGatewayChildState({
            repoRoot: params.repoRoot,
            tempRoot,
            env: bootstrapEnv,
            lifetime,
          }),
        );
      } else if (usesPackagedCandidate && gatewayCommand) {
        const command = {
          lifetime,
          executablePath: gatewayCommand.executablePath,
          argsPrefix: gatewayCommand.argsPrefix ?? [],
          cwd: gatewayCwd,
          env: createQaPackagedBootstrapEnv(env),
        };
        // The separate onboarding smoke cannot prepare this child's state.
        // Converge the freshly written config before verify-only startup.
        // Published candidates such as 2026.7.1-2 predate capability consent.
        const help = await runQaPackagedBootstrap(
          "installed package plugin setup failed (update repair --help)",
          () =>
            runQaGatewayCliCommand({
              ...command,
              args: ["update", "repair", "--help"],
              bootstrapPhase: "repair-help",
            }),
        );
        const consentArgs = help.includes("--accept-capabilities") ? ["--accept-capabilities"] : [];
        await runQaPackagedBootstrap("installed package plugin setup failed (update repair)", () =>
          runQaGatewayCliCommand({
            ...command,
            args: ["update", "repair", ...consentArgs, "--yes", "--no-restart", "--json"],
            bootstrapPhase: "repair",
          }),
        );
      }
      lifetime.assertOpen();
      return { cfg, env, gatewayPort, baseUrl, wsUrl };
    },
  };
}
