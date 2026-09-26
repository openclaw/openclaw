import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  acquireDebugProxyCaptureStore,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type { QaRunnerModelOption } from "../runner-contract.js";
import {
  closeQaHttpServer,
  dispatchQaHttpRequest,
  handleQaBusRequest,
  readQaJsonBody,
  writeError,
  writeJson,
} from "./bus-server.js";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { combineQaSuiteErrors, QaSuiteCleanupError, toQaError } from "./errors.js";
import {
  QaEvidenceGalleryError,
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFileByIndex,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceProducerFile,
} from "./evidence-gallery.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import {
  isCaptureQueryPreset,
  mapCaptureEventForQa,
  probeTcpReachability,
} from "./lab-server-capture.js";
import { QaLabRunUnavailableError, writeQaLabServerError } from "./lab-server-errors.js";
import {
  detectContentType,
  detectQaEvidenceArtifactContentType,
  isControlUiProxyPath,
  missingUiHtml,
  proxyHttpRequest,
  proxyUpgradeRequest,
  resolveAdvertisedBaseUrl,
  resolveUiAssetVersion,
  sanitizeControlUiPublicUrl,
  tryResolveUiAsset,
} from "./lab-server-ui.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import { createQaChannelGatewayConfig } from "./qa-channel-transport.js";
import {
  qaTransportSupportsModuleFlows,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import {
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
  resolveQaLabRunPlan,
} from "./run-config.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";
import { runQaSelfCheckAgainstState, type QaSelfCheckResult } from "./self-check.js";
import {
  readQaSuiteFailedOrSkippedScenarioCountFromFile,
  resolveQaReportOnlyOptionalScenarioNames,
} from "./suite-summary.js";

type QaLabBootstrapDefaults = {
  conversationKind: "direct" | "channel";
  conversationId: string;
  senderId: string;
  senderName: string;
};

export type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";

function countQaLabScenarioRun(scenarios: QaLabScenarioOutcome[]) {
  return {
    total: scenarios.length,
    pending: scenarios.filter((scenario) => scenario.status === "pending").length,
    running: scenarios.filter((scenario) => scenario.status === "running").length,
    passed: scenarios.filter((scenario) => scenario.status === "pass").length,
    failed: scenarios.filter((scenario) => scenario.status === "fail").length,
    skipped: scenarios.filter((scenario) => scenario.status === "skip").length,
  };
}

function withQaLabRunCounts(run: Omit<QaLabScenarioRun, "counts">): QaLabScenarioRun {
  return {
    ...run,
    counts: countQaLabScenarioRun(run.scenarios),
  };
}

function parseQaEvidenceArtifactIndexText(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new QaEvidenceGalleryError("Evidence artifact index is invalid.", 400);
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index) || String(index) !== value) {
    throw new QaEvidenceGalleryError("Evidence artifact index is invalid.", 400);
  }
  return index;
}

function injectKickoffMessage(params: {
  state: QaBusState;
  defaults: QaLabBootstrapDefaults;
  kickoffTask: string;
}) {
  return params.state.addInboundMessage({
    conversation: {
      id: params.defaults.conversationId,
      kind: params.defaults.conversationKind,
      ...(params.defaults.conversationKind === "channel"
        ? { title: params.defaults.conversationId }
        : {}),
    },
    senderId: params.defaults.senderId,
    senderName: params.defaults.senderName,
    text: params.kickoffTask,
  });
}

function createBootstrapDefaults(autoKickoffTarget?: string): QaLabBootstrapDefaults {
  const channel = autoKickoffTarget === "channel";
  return {
    conversationKind: channel ? "channel" : "direct",
    conversationId: channel ? "qa-lab" : "qa-operator",
    senderId: "qa-operator",
    senderName: "QA Operator",
  };
}

async function startQaGatewayLoop(params: { baseUrl: string }) {
  const { qaChannelPlugin, setQaChannelRuntime } = await import("openclaw/plugin-sdk/qa-channel");
  const runtime = createQaRunnerRuntime();
  setQaChannelRuntime(runtime);
  const cfg = createQaChannelGatewayConfig({ baseUrl: params.baseUrl });
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const task = Promise.resolve().then(
    async () =>
      await qaChannelPlugin.gateway?.startAccount?.({
        accountId: account.accountId,
        account,
        cfg,
        runtime: {
          log: () => undefined,
          error: () => undefined,
          exit: () => undefined,
        },
        abortSignal: abort.signal,
        log: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
        getStatus: () => ({
          accountId: account.accountId,
          configured: true,
          enabled: true,
          running: true,
        }),
        setStatus: () => undefined,
      }),
  );
  return {
    cfg,
    async stop() {
      abort.abort();
      await task;
    },
  };
}

export async function startQaLabServer(
  params?: QaLabServerStartParams,
): Promise<QaLabServerHandle> {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const captureSettings = resolveDebugProxySettings();
  let stopPromise: Promise<void> | null = null;
  let captureStoreLease: ReturnType<typeof acquireDebugProxyCaptureStore> | undefined;
  const getCaptureStore = () => {
    if (stopPromise) {
      throw new QaLabRunUnavailableError(503, "QA Lab is stopping");
    }
    return (captureStoreLease ??= acquireDebugProxyCaptureStore()).store;
  };
  const state = createQaBusState();
  let latestReport: QaLabLatestReport | null = null;
  let latestScenarioRun: QaLabScenarioRun | null = null;
  const scenarioCatalog = readQaBootstrapScenarioCatalog();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioCatalog.scenarios);
  const runnerChannels = [
    ...new Set(scenarioCatalog.scenarios.flatMap((scenario) => scenario.execution.channels ?? [])),
  ].toSorted();
  const bootstrapDefaults = createBootstrapDefaults(params?.autoKickoffTarget);
  let runnerModelOptions: QaRunnerModelOption[] = [];
  let runnerModelCatalogStatus: "loading" | "ready" | "failed" = "loading";
  const resolveServerRunPlan = async (
    selection: ReturnType<typeof normalizeQaRunSelection>,
    adapterFactories?: readonly QaTransportAdapterFactory[],
  ) => {
    const crabline =
      selection.channelDriver === "crabline" ? await import("@openclaw/crabline") : undefined;
    return resolveQaLabRunPlan({
      selection,
      scenarios: scenarioCatalog.scenarios,
      scorecardReport,
      defaultChannel:
        crabline?.OPENCLAW_CRABLINE_DEFAULT_CHANNEL ??
        (selection.channelDriver === "qa-channel" ? "qa-channel" : undefined),
      ...(crabline
        ? {
            supportsChannel: (channel: string) => {
              try {
                crabline.resolveOpenClawCrablineChannelDriverSelection({ channel });
                return true;
              } catch {
                return false;
              }
            },
          }
        : adapterFactories
          ? {
              supportsChannel: (channel: string) =>
                adapterFactories.some((factory) =>
                  factory.matches({ channelId: channel, driver: "live" }),
                ),
              resolveModuleFlowSupport: (channel?: string) =>
                channel
                  ? qaTransportSupportsModuleFlows(adapterFactories, {
                      channelId: channel,
                      driver: "live",
                    })
                  : false,
            }
          : {}),
    });
  };
  let runnerSnapshot = createIdleQaRunnerSnapshot(scorecardReport.profiles);
  runnerSnapshot.plan = await resolveServerRunPlan(runnerSnapshot.selection);
  let activeRun: { task: Promise<unknown>; controller: AbortController } | null = null;
  let runCleanupFailure: QaSuiteCleanupError | undefined;
  const assertRunAvailable = () => {
    if (stopPromise) {
      throw new QaLabRunUnavailableError(503, "QA Lab is stopping");
    }
    if (runCleanupFailure) {
      throw new QaLabRunUnavailableError(
        503,
        "QA Lab cleanup is unconfirmed; resolve the failure and restart QA Lab.",
      );
    }
    if (activeRun) {
      throw new QaLabRunUnavailableError(409, "QA run already in progress");
    }
  };
  const runAccepted = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    assertRunAvailable();
    const controller = new AbortController();
    const task = Promise.resolve()
      .then(() => run(controller.signal))
      .catch((error: unknown) => {
        // Settled work releases its active slot, but unconfirmed resources must
        // keep admission closed and remain observable by a later stop().
        if (error instanceof QaSuiteCleanupError) {
          runCleanupFailure = error;
        }
        throw error;
      })
      .finally(() => {
        activeRun = null;
      });
    activeRun = { task, controller };
    // HTTP suites return before completion; retain their rejection for shutdown
    // without creating an unhandled rejection after publishing the failed outcome.
    void task.catch(() => undefined);
    return task;
  };
  let controlUiProxyTarget = params?.controlUiProxyTarget?.trim()
    ? new URL(params.controlUiProxyTarget)
    : null;
  let controlUiProxyToken = params?.controlUiProxyToken?.trim() || null;
  let controlUiUrl = sanitizeControlUiPublicUrl(params?.controlUiUrl?.trim() || null);
  let gateway:
    | {
        cfg: OpenClawConfig;
        stop: () => Promise<void>;
      }
    | undefined;
  const embeddedGatewayEnabled = params?.embeddedGateway !== "disabled";
  let labHandle: QaLabServerHandle | null = null;
  let serverListening = false;

  let listenUrl = "";
  let publicBaseUrl = "";
  let runnerModelCatalogPromise: Promise<void> | null = null;
  let runnerModelCatalogAbort: AbortController | null = null;
  const ensureRunnerModelCatalog = () => {
    if (stopPromise || runnerModelCatalogPromise) {
      return runnerModelCatalogPromise;
    }
    runnerModelCatalogAbort = new AbortController();
    runnerModelCatalogPromise = (async () => {
      try {
        const { loadQaRunnerModelOptions } = await import("./model-catalog.runtime.js");
        runnerModelOptions = await loadQaRunnerModelOptions({
          repoRoot,
          signal: runnerModelCatalogAbort?.signal,
        });
        runnerModelCatalogStatus = "ready";
      } catch {
        runnerModelOptions = [];
        runnerModelCatalogStatus = "failed";
      }
    })().finally(() => {
      runnerModelCatalogAbort = null;
    });
    return runnerModelCatalogPromise;
  };

  async function runSelfCheck(): Promise<QaSelfCheckResult> {
    return await runAccepted(async (signal) => {
      const startedAt = new Date().toISOString();
      latestReport = null;
      latestScenarioRun = withQaLabRunCounts({
        kind: "self-check",
        status: "running",
        startedAt,
        scenarios: [
          {
            id: "qa-self-check",
            name: "Synthetic Slack-class roundtrip",
            status: "running",
          },
        ],
      });
      try {
        const result = await runQaSelfCheckAgainstState({
          signal,
          state,
          cfg: gateway?.cfg ?? createQaChannelGatewayConfig({ baseUrl: listenUrl }),
          transportId: "qa-channel",
          outputPath: params?.outputPath,
          repoRoot,
          waitTimeoutMs: params?.selfCheckWaitTimeoutMs,
        });
        const finishedAt = new Date().toISOString();
        latestScenarioRun = withQaLabRunCounts({
          kind: "self-check",
          status: "completed",
          startedAt,
          finishedAt,
          scenarios: [
            {
              id: "qa-self-check",
              name: result.scenarioResult.name,
              status: result.scenarioResult.status,
              details: result.scenarioResult.details,
              steps: result.scenarioResult.steps,
            },
          ],
        });
        latestReport = {
          outputPath: result.outputPath,
          markdown: result.report,
          generatedAt: finishedAt,
        };
        return result;
      } catch (error) {
        const finishedAt = new Date().toISOString();
        latestScenarioRun = withQaLabRunCounts({
          kind: "self-check",
          status: "completed",
          startedAt,
          finishedAt,
          scenarios: [
            {
              id: "qa-self-check",
              name: "Synthetic Slack-class roundtrip",
              status: "fail",
              details: formatErrorMessage(error),
              finishedAt,
            },
          ],
        });
        throw error;
      }
    });
  }

  const server = createServer((req, res) => {
    dispatchQaHttpRequest(res, async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (await handleQaBusRequest({ req, res, state })) {
        return;
      }

      try {
        if (controlUiProxyTarget && isControlUiProxyPath(url.pathname)) {
          await proxyHttpRequest({
            req,
            res,
            target: controlUiProxyTarget,
            pathname: url.pathname,
            search: url.search,
            authorizationToken: controlUiProxyToken,
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/bootstrap") {
          void ensureRunnerModelCatalog();
          const resolvedControlUiUrl = controlUiProxyTarget
            ? `${publicBaseUrl}/control-ui/`
            : controlUiUrl;
          const safeControlUiUrl = sanitizeControlUiPublicUrl(resolvedControlUiUrl);
          writeJson(res, 200, {
            baseUrl: publicBaseUrl,
            latestReport,
            controlUiUrl: safeControlUiUrl,
            controlUiEmbeddedUrl: safeControlUiUrl,
            kickoffTask: scenarioCatalog.kickoffTask,
            scenarios: scenarioCatalog.scenarios,
            defaults: bootstrapDefaults,
            runner: runnerSnapshot,
            runnerCatalog: {
              status: runnerModelCatalogStatus,
              real: runnerModelOptions,
              profiles: scorecardReport.profiles,
              channels: runnerChannels,
            },
          });
          return;
        }
        if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
          writeJson(res, 200, { ok: true, status: "live" });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/state") {
          writeJson(res, 200, state.getSnapshot());
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/report") {
          writeJson(res, 200, { report: latestReport });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/ui-version") {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ version: resolveUiAssetVersion(params?.uiDistDir, repoRoot) }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/outcomes") {
          writeJson(res, 200, { run: latestScenarioRun });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/evidence") {
          const evidencePath =
            url.searchParams.get("path")?.trim() || runnerSnapshot.artifacts?.evidencePath;
          if (!evidencePath) {
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify({ evidence: null }));
            return;
          }
          // Build the model before sending any headers so a thrown QaEvidenceGalleryError
          // still routes through writeQaLabServerError (writing headers first would make the
          // error response throw ERR_HTTP_HEADERS_SENT and reset the connection).
          const evidence = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ evidence }));
          return;
        }
        if (
          (req.method === "GET" || req.method === "HEAD") &&
          url.pathname === "/api/evidence/artifact"
        ) {
          const evidencePath = url.searchParams.get("evidencePath")?.trim();
          const artifactPath = url.searchParams.get("artifactPath")?.trim();
          const producerFile = url.searchParams.get("producerFile")?.trim();
          const entryIndexText = url.searchParams.get("entryIndex");
          const artifactIndexText = url.searchParams.get("artifactIndex");
          if (
            !evidencePath ||
            (!artifactPath && !producerFile && (!entryIndexText || !artifactIndexText))
          ) {
            writeError(res, 400, "Missing evidencePath and artifact selector");
            return;
          }
          const artifactFile = artifactPath
            ? await resolveQaEvidenceArtifactFile({
                artifactPath,
                evidencePath,
                repoRoot,
              })
            : producerFile
              ? await resolveQaEvidenceProducerFile({
                  evidencePath,
                  producerFile,
                  repoRoot,
                })
              : await resolveQaEvidenceArtifactFileByIndex({
                  artifactIndex: parseQaEvidenceArtifactIndexText(artifactIndexText!),
                  entryIndex: parseQaEvidenceArtifactIndexText(entryIndexText!),
                  evidencePath,
                  repoRoot,
                });
          const artifactStats = await fs.promises.stat(artifactFile);
          res.writeHead(200, {
            "content-type": detectQaEvidenceArtifactContentType(artifactFile),
            "content-length": artifactStats.size,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          fs.createReadStream(artifactFile)
            .on("error", (error) => res.destroy(toQaError(error)))
            .pipe(res);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/sessions") {
          writeJson(res, 200, {
            sessions: getCaptureStore().listSessions(50),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/startup-status") {
          const proxyUrl = captureSettings.proxyUrl || "http://127.0.0.1:7799";
          const gatewayUrl = controlUiUrl || "http://127.0.0.1:18789/";
          const [proxy, gatewayLocal] = await Promise.all([
            probeTcpReachability(proxyUrl),
            probeTcpReachability(gatewayUrl),
          ]);
          writeJson(res, 200, {
            status: {
              proxy: {
                ...proxy,
                label: "Proxy",
              },
              gateway: {
                ...gatewayLocal,
                label: "Gateway",
              },
              qaLab: {
                label: "QA Lab",
                url: publicBaseUrl,
                ok: true,
              },
            },
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/events") {
          const sessionId = url.searchParams.get("sessionId")?.trim();
          writeJson(res, 200, {
            events: sessionId
              ? getCaptureStore().getSessionEvents(sessionId, 200).map(mapCaptureEventForQa)
              : [],
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/coverage") {
          const sessionId = url.searchParams.get("sessionId")?.trim();
          if (!sessionId) {
            writeError(res, 400, "Missing sessionId");
            return;
          }
          writeJson(res, 200, {
            coverage: getCaptureStore().summarizeSessionCoverage(sessionId),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/query") {
          const preset = url.searchParams.get("preset")?.trim();
          const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
          if (!preset) {
            writeError(res, 400, "Missing preset");
            return;
          }
          if (!isCaptureQueryPreset(preset)) {
            writeError(res, 400, "Unknown preset");
            return;
          }
          writeJson(res, 200, {
            rows: getCaptureStore().queryPreset(preset, sessionId),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/blob") {
          const blobId = url.searchParams.get("id")?.trim();
          if (!blobId) {
            writeError(res, 400, "Missing blob id");
            return;
          }
          const content = getCaptureStore().readBlob(blobId);
          if (content == null) {
            writeError(res, 404, "Blob not found");
            return;
          }
          writeJson(res, 200, { id: blobId, content });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/capture/delete-sessions") {
          const body = (await readQaJsonBody(req)) as { sessionIds?: unknown };
          const sessionIds = Array.isArray(body.sessionIds)
            ? body.sessionIds.filter((value): value is string => typeof value === "string")
            : [];
          writeJson(res, 200, {
            result: getCaptureStore().deleteSessions(sessionIds),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/capture/purge") {
          writeJson(res, 200, {
            result: getCaptureStore().purgeAll(),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/reset") {
          assertRunAvailable();
          state.reset();
          latestReport = null;
          latestScenarioRun = null;
          runnerSnapshot = {
            ...runnerSnapshot,
            status: "idle",
            artifacts: null,
            error: null,
            startedAt: undefined,
            finishedAt: undefined,
          };
          writeJson(res, 200, { ok: true });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/inbound/message") {
          const body = await readQaJsonBody(req);
          writeJson(res, 200, {
            message: state.addInboundMessage(
              body as Parameters<QaBusState["addInboundMessage"]>[0],
            ),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/kickoff") {
          writeJson(res, 200, {
            message: injectKickoffMessage({
              state,
              defaults: bootstrapDefaults,
              kickoffTask: scenarioCatalog.kickoffTask,
            }),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/scenario/self-check") {
          const result = await runSelfCheck();
          writeJson(res, 200, serializeSelfCheck(result));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/scenario/suite") {
          assertRunAvailable();
          let selection: ReturnType<typeof normalizeQaRunSelection>;
          let plan: ReturnType<typeof resolveQaLabRunPlan>;
          let adapterFactories: readonly QaTransportAdapterFactory[] | undefined;
          try {
            selection = normalizeQaRunSelection(
              await readQaJsonBody(req),
              scenarioCatalog.scenarios,
              scorecardReport.profiles,
            );
            adapterFactories =
              selection.channelDriver === "live"
                ? (await import("./live-transports/cli.js")).listLiveTransportQaAdapterFactories()
                : undefined;
            plan = await resolveServerRunPlan(selection, adapterFactories);
          } catch (error) {
            writeError(res, 400, error);
            return;
          }
          // Body reads and adapter discovery yield to shutdown or another run.
          // Admission must still hold at the shared-state reset boundary.
          assertRunAvailable();
          if (plan.status === "invalid") {
            writeJson(res, 400, {
              error: plan.errors.join(" "),
              plan,
            });
            return;
          }
          state.reset();
          latestReport = null;
          const startedAt = new Date().toISOString();
          latestScenarioRun = withQaLabRunCounts({
            kind: "suite",
            status: "running",
            startedAt,
            scenarios: plan.selectedScenarios.map((scenario) => ({
              id: scenario.id,
              name: scenario.title,
              status: "pending",
            })),
          });
          runnerSnapshot = {
            status: "running",
            selection,
            plan,
            startedAt,
            finishedAt: undefined,
            artifacts: null,
            error: null,
          };
          void runAccepted(async (signal) => {
            // Keep generated artifacts visible when authenticated verdict validation fails.
            let artifacts: ReturnType<typeof createIdleQaRunnerSnapshot>["artifacts"] = null;
            try {
              const { runQaSuite } = await import("./suite-launch.runtime.js");
              const runtimeResult = await runQaSuite({
                signal,
                forwardParentSignals: false,
                lab: labHandle ?? undefined,
                startLab: startQaLabServer,
                controlUiEnabled: true,
                repoRoot,
                outputDir: createQaRunOutputDir(repoRoot),
                channelDriver: selection.channelDriver,
                ...(adapterFactories ? { adapterFactories } : {}),
                ...(selection.channel ? { channelId: selection.channel } : {}),
                evidenceMode: selection.evidenceMode,
                providerMode: selection.providerMode,
                primaryModel: selection.primaryModel,
                alternateModel: selection.alternateModel,
                fastMode: selection.fastMode,
                scenarioIds: plan.selectedScenarios.map((scenario) => scenario.id),
                ...(selection.runtimePair ? { runtimePair: selection.runtimePair } : {}),
              });
              const result = runtimeResult.result;
              const finishedAt = new Date().toISOString();
              artifacts = {
                outputDir: result.outputDir,
                evidencePath: result.evidencePath,
                reportPath: result.reportPath,
                summaryPath: result.summaryPath,
                watchUrl:
                  "watchUrl" in result && typeof result.watchUrl === "string"
                    ? result.watchUrl
                    : (labHandle?.baseUrl ?? publicBaseUrl),
              };
              latestReport = {
                outputPath: result.reportPath,
                markdown: result.report,
                generatedAt: finishedAt,
              };
              const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
                result.summaryPath,
                {
                  optionalScenarioNames: plan.explicitScenarioSelection
                    ? undefined
                    : resolveQaReportOnlyOptionalScenarioNames(scenarioCatalog.scenarios),
                },
              );
              runnerSnapshot = {
                status: blockingScenarioCount > 0 ? "failed" : "completed",
                selection,
                plan,
                startedAt,
                finishedAt,
                artifacts,
                error:
                  blockingScenarioCount > 0
                    ? `QA suite reported ${blockingScenarioCount} failed or skipped scenario(s).`
                    : null,
              };
            } catch (error) {
              const finishedAt = new Date().toISOString();
              const message = formatErrorMessage(error);
              latestScenarioRun = withQaLabRunCounts({
                kind: "suite",
                status: "completed",
                startedAt,
                finishedAt,
                scenarios: (latestScenarioRun?.scenarios ?? []).map((scenario) =>
                  scenario.status === "pending" || scenario.status === "running"
                    ? Object.assign({}, scenario, {
                        status: "fail" as const,
                        details: message,
                        finishedAt,
                      })
                    : scenario,
                ),
              });
              runnerSnapshot = {
                status: "failed",
                selection,
                plan,
                startedAt,
                finishedAt,
                artifacts,
                error: message,
              };
              throw error;
            }
          });
          writeJson(res, 202, {
            ok: true,
            plan,
            runner: runnerSnapshot,
          });
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          writeError(res, 404, "not found");
          return;
        }

        const asset = tryResolveUiAsset(url.pathname, params?.uiDistDir, repoRoot);
        if (!asset) {
          const html = missingUiHtml();
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          res.end(html);
          return;
        }

        const body = fs.readFileSync(asset);
        res.writeHead(200, {
          "content-type": detectContentType(asset),
          "content-length": body.byteLength,
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(body);
      } catch (error) {
        await writeQaLabServerError(req, res, error);
      }
    });
  });

  const releaseCaptureStore = () => {
    captureStoreLease?.release();
    captureStoreLease = undefined;
  };

  const stopLabServerResources = async (): Promise<void> => {
    runnerModelCatalogAbort?.abort();
    const run = activeRun;
    run?.controller.abort(new DOMException("QA Lab run cancelled during shutdown", "AbortError"));
    const errors: Error[] = !run && runCleanupFailure ? [runCleanupFailure] : [];
    // Accepted runs own their workers, report writes and terminal publication.
    // Cancel execution first, then keep the Gateway and bus alive through its drain.
    const cancelledRun = run?.task.catch((error: unknown) => {
      if (error !== run.controller.signal.reason) {
        throw error;
      }
    });
    for (const result of await Promise.allSettled([cancelledRun, runnerModelCatalogPromise])) {
      if (result.status === "rejected") {
        errors.push(toQaError(result.reason));
      }
    }
    // Gateway shutdown can still flush through the bus. Close HTTP before
    // releasing capture storage so late body readers cannot reacquire it.
    for (const cleanup of [
      () => gateway?.stop(),
      () => (serverListening ? closeQaHttpServer(server, state) : undefined),
      releaseCaptureStore,
    ]) {
      try {
        await Promise.resolve().then(cleanup);
      } catch (error) {
        errors.push(toQaError(error));
      }
    }
    const [firstError] = errors;
    if (firstError) {
      throw errors.length === 1
        ? firstError
        : combineQaSuiteErrors(errors, "QA Lab shutdown failed", { cause: firstError });
    }
  };
  // Fence admission synchronously, before any shutdown callback can run.
  const stop = () => (stopPromise ??= Promise.resolve().then(stopLabServerResources));

  try {
    await once(server.listen(params?.port ?? 0, params?.host ?? "127.0.0.1"), "listening");
    serverListening = true;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("qa-lab failed to bind");
    }
    listenUrl = resolveAdvertisedBaseUrl({
      bindHost: params?.host ?? "127.0.0.1",
      bindPort: address.port,
    });
    publicBaseUrl = resolveAdvertisedBaseUrl({
      bindHost: params?.host ?? "127.0.0.1",
      bindPort: address.port,
      advertiseHost: params?.advertiseHost,
      advertisePort: params?.advertisePort,
    });
    if (embeddedGatewayEnabled) {
      gateway = await startQaGatewayLoop({ baseUrl: listenUrl });
    }
    if (params?.sendKickoffOnStart) {
      injectKickoffMessage({
        state,
        defaults: bootstrapDefaults,
        kickoffTask: scenarioCatalog.kickoffTask,
      });
    }

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!controlUiProxyTarget || !isControlUiProxyPath(url.pathname)) {
        socket.destroy();
        return;
      }
      proxyUpgradeRequest({
        req,
        socket,
        head,
        target: controlUiProxyTarget,
        authorizationToken: controlUiProxyToken,
      });
    });

    const lab = {
      baseUrl: publicBaseUrl,
      listenUrl,
      state,
      setControlUi(next: {
        controlUiUrl?: string | null;
        controlUiProxyToken?: string | null;
        controlUiProxyTarget?: string | null;
      }) {
        controlUiUrl = sanitizeControlUiPublicUrl(next.controlUiUrl?.trim() || null);
        controlUiProxyToken = next.controlUiProxyToken?.trim() || null;
        controlUiProxyTarget = next.controlUiProxyTarget?.trim()
          ? new URL(next.controlUiProxyTarget)
          : null;
      },
      setScenarioRun(next: Omit<QaLabScenarioRun, "counts"> | null) {
        latestScenarioRun = next ? withQaLabRunCounts(next) : null;
      },
      setLatestReport(next: QaLabLatestReport | null) {
        latestReport = next;
      },
      runSelfCheck,
      stop,
    };
    labHandle = lab;
    return lab;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await stop();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "QA Lab startup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

function serializeSelfCheck(result: QaSelfCheckResult) {
  return {
    outputPath: result.outputPath,
    report: result.report,
    checks: result.checks,
    scenario: result.scenarioResult,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
