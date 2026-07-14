// QA Lab Slack live orchestration and stable public test surface.
import fs from "node:fs/promises";
import path from "node:path";
import { createSlackWebClient, createSlackWriteClient } from "@openclaw/slack/api.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createQaArtifactRunId } from "../../artifact-run-id.js";
import { QA_EVIDENCE_FILENAME, buildLiveTransportEvidenceSummary } from "../../evidence-summary.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import {
  appendQaLiveLaneIssue as appendLiveLaneIssue,
  buildQaLiveLaneArtifactsError as buildLiveLaneArtifactsError,
} from "../shared/live-artifacts.js";
import { inferQaCredentialSource as inferSlackCredentialSource } from "../shared/live-credential-source.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import { resolveSlackApprovalCheckpointConfig } from "./slack-live.approval-checkpoint.js";
import {
  matchesSlackApprovalPromptText,
  matchesSlackApprovalResolvedUpdate,
  resolveApprovalDecision,
  runSlackApprovalScenario,
} from "./slack-live.approvals.js";
import {
  isRetryableSlackQaScenarioError,
  toObservedSlackArtifacts,
  toSlackQaScenarioArtifactResults,
  renderSlackQaMarkdown,
  preserveSlackGatewayDebugArtifacts,
} from "./slack-live.artifacts.js";
import { runSlackCodexApprovalScenario } from "./slack-live.codex-approval-runner.js";
import {
  buildCodexApprovalInstruction,
  readAcceptedAgentRunId,
  waitForSlackReaction,
  assertCodexApprovalTranscriptSucceeded,
  findPendingCodexPluginApprovalRecord,
  quiesceCodexApprovalAgentRun,
  resolveCodexFileApprovalTargetPath,
} from "./slack-live.codex-approval.js";
import {
  resolveSlackQaRuntimeEnv,
  parseSlackQaCredentialPayload,
  buildSlackQaConfig,
} from "./slack-live.config.js";
import {
  type SlackQaRuntimeEnv,
  type SlackChannelReadinessMode,
  SLACK_QA_GATEWAY_STOP_SETTLE_MS,
  SLACK_QA_RETRYABLE_SCENARIO_ATTEMPTS,
  assertSlackCodexApprovalModelSupported,
  resolveSlackQaSutAccountId,
  type SlackQaGatewayHarness,
  type SlackObservedMessage,
  type SlackQaScenarioResult,
  type SlackQaRunResult,
  type SlackCredentialLease,
  type SlackCredentialHeartbeat,
  SLACK_QA_CAPTURE_CONTENT_ENV,
  QA_REDACT_PUBLIC_METADATA_ENV,
  SLACK_QA_WEB_API_TIMEOUT_MS,
} from "./slack-live.contracts.js";
import { buildSlackInvalidBlocksTableProbe } from "./slack-live.invalid-blocks.js";
import {
  waitForSlackScenarioReply,
  observeSlackScenarioMessages,
  waitForSlackNoReply,
  waitForSlackChannelStable,
  isSlackChannelReadyForQa,
  resolveSlackChannelReadySince,
  resolveSlackQaReadyTimeoutMs,
} from "./slack-live.message-observations.js";
import {
  getSlackIdentity,
  sendSlackChannelMessage,
  listSlackMessages,
  listSlackThreadMessages,
  collectSlackBlockText,
  collectSlackActionValues,
  parseSlackNativeApprovalAction,
  collectSlackButtonLabels,
  buildSlackApprovalCheckpointMessage,
  extractSlackNativeApprovalId,
  waitForSlackStoredMessage,
  runSlackTableInvalidBlocksFallbackScenario,
} from "./slack-live.observations.js";
import { SLACK_QA_STANDARD_SCENARIO_IDS, findScenario } from "./slack-live.scenarios.js";

export { listSlackQaScenarioCatalog } from "./slack-live.scenarios.js";

export async function runSlackQaLive(params: {
  alternateModel?: string;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<SlackQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `slack-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = resolveSlackQaSutAccountId(params.sutAccountId);
  const scenarios = findScenario(params.scenarioIds);
  if (scenarios.some((scenario) => scenario.configOverrides?.codexApproval === true)) {
    assertSlackCodexApprovalModelSupported(primaryModel);
  }
  const requestedCredentialSource = inferSlackCredentialSource(params.credentialSource);
  const redactPublicMetadata = isTruthyOptIn(process.env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const includeObservedMessageContent = isTruthyOptIn(process.env[SLACK_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const observedMessages: SlackObservedMessage[] = [];
  const scenarioResults: SlackQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let credentialLease: SlackCredentialLease | undefined;
  let leaseHeartbeat: SlackCredentialHeartbeat | undefined;
  let runtimeEnv: SlackQaRuntimeEnv | undefined;

  try {
    credentialLease = await acquireQaCredentialLease({
      kind: "slack",
      source: params.credentialSource,
      role: params.credentialRole,
      resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
      parsePayload: parseSlackQaCredentialPayload,
    });
    leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
    const assertLeaseHealthy = () => {
      leaseHeartbeat?.throwIfFailed();
    };
    const activeRuntimeEnv = credentialLease.payload;
    runtimeEnv = activeRuntimeEnv;

    const [driverIdentity, sutIdentity] = await Promise.all([
      getSlackIdentity(activeRuntimeEnv.driverBotToken),
      getSlackIdentity(activeRuntimeEnv.sutBotToken),
    ]);
    if (driverIdentity.userId === sutIdentity.userId) {
      throw new Error("Slack QA requires two distinct bots for driver and SUT.");
    }

    const driverClient = createSlackWriteClient(activeRuntimeEnv.driverBotToken, {
      timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
    });
    const sutReadClient = createSlackWebClient(activeRuntimeEnv.sutBotToken, {
      timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
    });
    for (const scenario of scenarios) {
      let scenarioAttempt = 1;
      while (true) {
        let gatewayHarness: SlackQaGatewayHarness | undefined;
        let codexProbeCleanupPath: string | undefined;
        let preserveAttemptGatewayDebug = false;
        let retryScenario = false;
        try {
          assertLeaseHealthy();
          const scenarioRun = scenario.buildRun(sutIdentity.userId);
          if (scenarioRun.kind === "direct-transport") {
            const directResult = await scenarioRun.execute({
              cfg: buildSlackQaConfig(
                {},
                {
                  channelId: activeRuntimeEnv.channelId,
                  driverBotUserId: driverIdentity.userId,
                  overrides: scenario.configOverrides,
                  primaryModel,
                  sutAccountId,
                  sutAppToken: activeRuntimeEnv.sutAppToken,
                  sutBotToken: activeRuntimeEnv.sutBotToken,
                },
              ),
              channelId: activeRuntimeEnv.channelId,
              sutAccountId,
              sutIdentity,
              sutReadClient,
              sutWriteClient: createSlackWriteClient(activeRuntimeEnv.sutBotToken, {
                timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
              }),
              timeoutMs: scenario.timeoutMs,
            });
            const message = directResult.message;
            if (!message.ts) {
              throw new Error("direct Slack transport scenario returned no stored message id");
            }
            observedMessages.push({
              actionValues: collectSlackActionValues(message.blocks),
              blockText: collectSlackBlockText(message.blocks),
              botId: message.bot_id,
              channelId: activeRuntimeEnv.channelId,
              matchedScenario: true,
              scenarioId: scenario.id,
              scenarioTitle: scenario.title,
              text: message.text ?? "",
              threadTs: message.thread_ts,
              ts: message.ts,
              userId: message.user,
            });
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: [
                directResult.details,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
            });
            break;
          }
          gatewayHarness = await startQaLiveLaneGateway({
            repoRoot,
            transport: {
              requiredPluginIds: [],
              createGatewayConfig: () => ({}),
            },
            transportBaseUrl: "http://127.0.0.1:0",
            providerMode,
            primaryModel,
            alternateModel,
            fastMode: params.fastMode,
            forcedRuntime: scenario.forcedRuntime,
            controlUiEnabled: false,
            mutateConfig: (cfg) =>
              buildSlackQaConfig(cfg, {
                channelId: activeRuntimeEnv.channelId,
                driverBotUserId: driverIdentity.userId,
                overrides: scenario.configOverrides,
                primaryModel,
                sutAccountId,
                sutAppToken: activeRuntimeEnv.sutAppToken,
                sutBotToken: activeRuntimeEnv.sutBotToken,
              }),
          });
          const activeGatewayHarness = gatewayHarness;
          if (
            scenarioRun.kind === "codex-approval" &&
            scenarioRun.appServerMethod === "item/fileChange/requestApproval"
          ) {
            codexProbeCleanupPath = resolveCodexFileApprovalTargetPath(scenarioRun.token);
          }
          const readinessMode: SlackChannelReadinessMode =
            scenarioRun.kind === "approval" || scenarioRun.kind === "codex-approval"
              ? "started"
              : "connected";
          await waitForSlackChannelStable(
            activeGatewayHarness.gateway,
            sutAccountId,
            readinessMode,
          );
          const baseScenarioContext = {
            channelId: activeRuntimeEnv.channelId,
            driverClient,
            gateway: activeGatewayHarness.gateway,
            postSlackMessage: async (message: { text: string; threadTs?: string }) =>
              await sendSlackChannelMessage({
                channelId: activeRuntimeEnv.channelId,
                client: driverClient,
                text: message.text,
                threadTs: message.threadTs,
              }),
            sutIdentity,
            sutReadClient,
            waitForReady: async () =>
              await waitForSlackChannelStable(
                activeGatewayHarness.gateway,
                sutAccountId,
                "connected",
              ),
          };
          if (scenarioRun.kind === "approval") {
            const approval = await runSlackApprovalScenario({
              channelId: activeRuntimeEnv.channelId,
              context: baseScenarioContext,
              observedMessages,
              run: scenarioRun,
              scenario,
              sutAccountId,
            });
            scenarioResults.push({
              approval: approval.artifact,
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "pass",
              details: [
                `${scenarioRun.approvalKind} approval resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs: approval.rttMs,
              requestStartedAt: approval.requestStartedAt.toISOString(),
              responseObservedAt: approval.responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: approval.rttMs,
                requestStartedAt: approval.requestStartedAt.toISOString(),
                responseObservedAt: approval.responseObservedAt.toISOString(),
                source: "approval-request-to-resolution",
              },
            });
            break;
          }
          if (scenarioRun.kind === "codex-approval") {
            const approval = await runSlackCodexApprovalScenario({
              channelId: activeRuntimeEnv.channelId,
              context: baseScenarioContext,
              observedMessages,
              primaryModel,
              run: scenarioRun,
              scenario,
              stopGateway: async (preserveDebugArtifacts) => {
                await activeGatewayHarness.stop(
                  preserveDebugArtifacts ? { preserveToDir: gatewayDebugDirPath } : undefined,
                );
                await new Promise((resolve) => {
                  setTimeout(resolve, SLACK_QA_GATEWAY_STOP_SETTLE_MS);
                });
                gatewayHarness = undefined;
                if (preserveDebugArtifacts) {
                  preservedGatewayDebugArtifacts = true;
                }
              },
              sutAccountId,
            });
            scenarioResults.push({
              approval: approval.artifact,
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: [
                `Codex ${scenarioRun.appServerMethod} approval resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs: approval.rttMs,
              requestStartedAt: approval.requestStartedAt.toISOString(),
              responseObservedAt: approval.responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: approval.rttMs,
                requestStartedAt: approval.requestStartedAt.toISOString(),
                responseObservedAt: approval.responseObservedAt.toISOString(),
                source: "approval-request-to-resolution",
              },
            });
            break;
          }
          const beforeRunResult = await scenarioRun.beforeRun?.(baseScenarioContext);
          const beforeRunDetails =
            typeof beforeRunResult === "string" ? beforeRunResult : beforeRunResult?.details;
          // Keep identity checks attempt-local so earlier scenario traffic cannot mask duplicates.
          const observedMessageStartIndex = observedMessages.length;
          const requestStartedAt = new Date();
          const sent = await sendSlackChannelMessage({
            channelId: activeRuntimeEnv.channelId,
            client: driverClient,
            text: scenarioRun.input,
            threadTs:
              typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined,
          });
          const requestThreadTs =
            (typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined) ??
            sent.ts;
          if (scenarioRun.expectReply) {
            const reply = await waitForSlackScenarioReply({
              channelId: activeRuntimeEnv.channelId,
              client: sutReadClient,
              matchText: scenarioRun.matchText,
              observedMessages,
              observationScenarioId: scenario.id,
              observationScenarioTitle: scenario.title,
              sentTs: sent.ts,
              threadTs: requestThreadTs,
              sutIdentity,
              timeoutMs: scenario.timeoutMs,
            });
            scenarioRun.verify?.(reply.message, { requestThreadTs, sentTs: sent.ts });
            if (scenarioRun.settleObservedMs) {
              // Negative and dedupe checks need late Slack deliveries, not only the first final hit.
              await observeSlackScenarioMessages({
                channelId: activeRuntimeEnv.channelId,
                client: sutReadClient,
                matchText: scenarioRun.matchText,
                observedMessages,
                observationScenarioId: scenario.id,
                observationScenarioTitle: scenario.title,
                sentTs: sent.ts,
                settleMs: scenarioRun.settleObservedMs,
                sutIdentity,
                threadTs: requestThreadTs,
              });
            }
            const observedDetails = scenarioRun.verifyObserved?.({
              finalMessage: reply.message,
              messages: observedMessages.slice(observedMessageStartIndex),
            });
            const responseObservedAt = new Date(reply.observedAt);
            const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
            const afterReplyDetails = await scenarioRun.afterReply?.(reply.message, {
              ...baseScenarioContext,
              sentTs: sent.ts,
            });
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "pass",
              details: [
                `reply matched in ${rttMs}ms`,
                beforeRunDetails,
                observedDetails,
                afterReplyDetails,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs,
              requestStartedAt: requestStartedAt.toISOString(),
              responseObservedAt: responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: rttMs,
                requestStartedAt: requestStartedAt.toISOString(),
                responseObservedAt: responseObservedAt.toISOString(),
                source: "request-to-observed-message",
              },
            });
          } else {
            await waitForSlackNoReply({
              channelId: activeRuntimeEnv.channelId,
              client: sutReadClient,
              matchText: scenarioRun.matchText,
              observedMessages,
              observationScenarioId: scenario.id,
              observationScenarioTitle: scenario.title,
              sentTs: sent.ts,
              sutIdentity,
              timeoutMs: scenario.timeoutMs,
            });
            const afterNoReplyDetails = await scenarioRun.afterNoReply?.({
              ...baseScenarioContext,
              sentTs: sent.ts,
            });
            if (scenarioRun.preserveGatewayDebug) {
              preserveAttemptGatewayDebug = true;
              preservedGatewayDebugArtifacts = true;
            }
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "pass",
              details: [
                "no reply",
                afterNoReplyDetails,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
            });
          }
          break;
        } catch (error) {
          if (
            scenarioAttempt < SLACK_QA_RETRYABLE_SCENARIO_ATTEMPTS &&
            isRetryableSlackQaScenarioError(error)
          ) {
            scenarioAttempt += 1;
            retryScenario = true;
          } else {
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "fail",
              details:
                scenarioAttempt > 1
                  ? `${formatErrorMessage(error)}; retried ${scenarioAttempt - 1}x`
                  : formatErrorMessage(error),
            });
            if (gatewayHarness) {
              preserveAttemptGatewayDebug = true;
              preservedGatewayDebugArtifacts = true;
              const stopped = await preserveSlackGatewayDebugArtifacts({
                cleanupIssues,
                gatewayDebugDirPath,
                gatewayHarness,
              });
              if (stopped) {
                gatewayHarness = undefined;
              }
            }
          }
        } finally {
          if (gatewayHarness) {
            await gatewayHarness
              .stop(
                preserveAttemptGatewayDebug ? { preserveToDir: gatewayDebugDirPath } : undefined,
              )
              .then(() => {
                gatewayHarness = undefined;
                if (preserveAttemptGatewayDebug) {
                  preservedGatewayDebugArtifacts = true;
                }
              })
              .catch((error: unknown) => {
                appendLiveLaneIssue(cleanupIssues, "gateway stop failed", error);
                retryScenario = false;
                const details = `gateway stop failed: ${formatErrorMessage(error)}`;
                const currentResult = scenarioResults.at(-1);
                if (currentResult?.id === scenario.id) {
                  scenarioResults[scenarioResults.length - 1] = {
                    ...currentResult,
                    status: "fail",
                    details: `${currentResult.details}; ${details}`,
                  };
                } else {
                  scenarioResults.push({
                    id: scenario.id,
                    title: scenario.title,
                    standardId: scenario.standardId,
                    status: "fail",
                    details,
                  });
                }
              });
            if (!gatewayHarness) {
              await new Promise((resolve) => {
                setTimeout(resolve, SLACK_QA_GATEWAY_STOP_SETTLE_MS);
              });
            }
          }
          if (!gatewayHarness && codexProbeCleanupPath) {
            await fs.rm(codexProbeCleanupPath, { force: true }).catch((error: unknown) => {
              appendLiveLaneIssue(cleanupIssues, "Codex approval probe cleanup failed", error);
            });
          }
        }
        if (retryScenario) {
          continue;
        }
        break;
      }
      if (scenarioResults.at(-1)?.status === "fail") {
        break;
      }
    }
  } catch (error) {
    cleanupIssues.push(
      buildLiveLaneArtifactsError({
        heading: "Slack QA failed before scenario completion.",
        details: [formatErrorMessage(error)],
        artifacts: {
          gatewayDebug: gatewayDebugDirPath,
        },
      }),
    );
    preservedGatewayDebugArtifacts = true;
    await fs.mkdir(gatewayDebugDirPath, { recursive: true }).catch(() => {});
    scenarioResults.push({
      id: "slack-canary",
      title: "Slack canary echo",
      standardId: "canary",
      status: "fail",
      details: formatErrorMessage(error),
    });
  } finally {
    if (leaseHeartbeat) {
      try {
        await leaseHeartbeat.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential heartbeat stop failed", error);
      }
    }
    if (credentialLease) {
      try {
        await credentialLease.release();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential release failed", error);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "slack-qa-report.md");
  const summaryPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  const observedMessagesPath = path.join(outputDir, "slack-qa-observed-messages.json");
  const artifactScenarioResults = toSlackQaScenarioArtifactResults({
    scenarios: scenarioResults,
    includeContent: includeObservedMessageContent,
    redactMetadata: redactPublicMetadata,
  });
  const evidence = buildLiveTransportEvidenceSummary({
    artifactPaths: [
      { kind: "summary", path: path.basename(summaryPath) },
      { kind: "report", path: path.basename(reportPath) },
      { kind: "transport-observations", path: path.basename(observedMessagesPath) },
    ],
    checks: artifactScenarioResults.map(({ standardId, ...check }) => ({
      ...check,
      coverageIds: standardId ? [`channels.slack.${standardId}`] : undefined,
    })),
    env: process.env,
    generatedAt: finishedAt,
    primaryModel,
    providerMode,
    repoRoot,
    transportId: "slack",
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      toObservedSlackArtifacts({
        messages: observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await fs.writeFile(
    reportPath,
    `${renderSlackQaMarkdown({
      channelId: runtimeEnv?.channelId ?? "<unavailable>",
      cleanupIssues,
      credentialSource: credentialLease?.source ?? requestedCredentialSource,
      finishedAt,
      gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
      redactMetadata: redactPublicMetadata,
      scenarios: artifactScenarioResults,
      startedAt,
    })}\n`,
  );
  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
    scenarios: artifactScenarioResults,
  };
}

const testing = {
  assertSlackCodexApprovalModelSupported,
  assertCodexApprovalTranscriptSucceeded,
  buildCodexApprovalInstruction,
  buildSlackInvalidBlocksTableProbe,
  buildSlackApprovalCheckpointMessage,
  buildSlackQaConfig,
  collectSlackActionValues,
  collectSlackButtonLabels,
  collectSlackBlockText,
  extractSlackNativeApprovalId,
  findPendingCodexPluginApprovalRecord,
  findScenario,
  getSlackIdentity,
  isSlackChannelReadyForQa,
  matchesSlackApprovalResolvedUpdate,
  matchesSlackApprovalPromptText,
  observeSlackScenarioMessages,
  parseSlackNativeApprovalAction,
  parseSlackQaCredentialPayload,
  preserveSlackGatewayDebugArtifacts,
  quiesceCodexApprovalAgentRun,
  readAcceptedAgentRunId,
  resolveCodexFileApprovalTargetPath,
  resolveSlackChannelReadySince,
  resolveSlackQaReadyTimeoutMs,
  resolveSlackApprovalCheckpointConfig,
  resolveApprovalDecision,
  resolveSlackQaSutAccountId,
  resolveSlackQaRuntimeEnv,
  runSlackTableInvalidBlocksFallbackScenario,
  sendSlackChannelMessage,
  listSlackMessages,
  listSlackThreadMessages,
  SLACK_QA_STANDARD_SCENARIO_IDS,
  toSlackQaScenarioArtifactResults,
  waitForSlackStoredMessage,
  waitForSlackNoReply,
  waitForSlackReaction,
  waitForSlackChannelStable,
};
export { testing as __testing };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
