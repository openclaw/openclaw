import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLiveLaneGateway } from "./live-gateway.runtime.js";
import { appendLiveLaneIssue, buildLiveLaneArtifactsError } from "./live-lane-helpers.js";
import {
  createMatrixQaClient,
  provisionMatrixQaRoom,
  type MatrixQaObservedEvent,
  type MatrixQaProvisionResult,
} from "./matrix-driver-client.js";
import { startMatrixQaHarness } from "./matrix-harness.runtime.js";
import type { QaReportCheck } from "./report.js";
import { renderQaMarkdownReport } from "./report.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "./run-config.js";

type MatrixQaScenarioDefinition = {
  id: "matrix-thread-follow-up" | "matrix-thread-isolation";
  timeoutMs: number;
  title: string;
};

type MatrixQaReplyArtifact = {
  eventId: string;
  mentions?: MatrixQaObservedEvent["mentions"];
  relatesTo?: MatrixQaObservedEvent["relatesTo"];
  sender?: string;
  tokenMatched: boolean;
};

type MatrixQaCanaryArtifact = {
  driverEventId: string;
  reply: MatrixQaReplyArtifact;
  token: string;
};

type MatrixQaScenarioArtifacts = {
  driverEventId?: string;
  rootEventId?: string;
  reply?: MatrixQaReplyArtifact;
  threadDriverEventId?: string;
  threadReply?: MatrixQaReplyArtifact;
  threadRootEventId?: string;
  threadToken?: string;
  token?: string;
  topLevelDriverEventId?: string;
  topLevelReply?: MatrixQaReplyArtifact;
  topLevelToken?: string;
};

type MatrixQaScenarioResult = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
  id: string;
  status: "fail" | "pass";
  title: string;
};

type MatrixQaSummary = {
  checks: QaReportCheck[];
  counts: {
    failed: number;
    passed: number;
    total: number;
  };
  finishedAt: string;
  harness: {
    baseUrl: string;
    composeFile: string;
    image: string;
    roomId: string;
    serverName: string;
  };
  canary?: MatrixQaCanaryArtifact;
  observedEventCount: number;
  observedEventsPath: string;
  reportPath: string;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  summaryPath: string;
  sutAccountId: string;
  userIds: {
    driver: string;
    observer: string;
    sut: string;
  };
};

export type MatrixQaRunResult = {
  observedEventsPath: string;
  outputDir: string;
  reportPath: string;
  scenarios: MatrixQaScenarioResult[];
  summaryPath: string;
};

const MATRIX_QA_SCENARIOS: MatrixQaScenarioDefinition[] = [
  {
    id: "matrix-thread-follow-up",
    timeoutMs: 60_000,
    title: "Matrix thread follow-up reply",
  },
  {
    id: "matrix-thread-isolation",
    timeoutMs: 75_000,
    title: "Matrix top-level reply stays out of prior thread",
  },
];

function buildMatrixQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    driverUserId: string;
    homeserver: string;
    roomId: string;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "matrix"])];
  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        matrix: { enabled: true },
      },
    },
    channels: {
      ...baseCfg.channels,
      matrix: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            accessToken: params.sutAccessToken,
            ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
            dm: { enabled: false },
            enabled: true,
            encryption: false,
            groupAllowFrom: [params.driverUserId],
            groupPolicy: "allowlist",
            groups: {
              [params.roomId]: {
                enabled: true,
                requireMention: true,
              },
            },
            homeserver: params.homeserver,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            replyToMode: "off",
            threadReplies: "inbound",
            userId: params.sutUserId,
          },
        },
      },
    },
  };
}

function buildObservedEventsArtifact(params: {
  includeContent: boolean;
  observedEvents: MatrixQaObservedEvent[];
}) {
  return params.observedEvents.map((event) =>
    params.includeContent
      ? event
      : {
          roomId: event.roomId,
          eventId: event.eventId,
          sender: event.sender,
          stateKey: event.stateKey,
          type: event.type,
          originServerTs: event.originServerTs,
          msgtype: event.msgtype,
          membership: event.membership,
          relatesTo: event.relatesTo,
          mentions: event.mentions,
        },
  );
}

function findScenario(ids?: string[]) {
  if (!ids || ids.length === 0) {
    return [...MATRIX_QA_SCENARIOS];
  }
  const requested = new Set(ids);
  const selected = MATRIX_QA_SCENARIOS.filter((scenario) => ids.includes(scenario.id));
  const missingIds = [...requested].filter(
    (id) => !selected.some((scenario) => scenario.id === id),
  );
  if (missingIds.length > 0) {
    throw new Error(`unknown Matrix QA scenario id(s): ${missingIds.join(", ")}`);
  }
  return selected;
}

function isMatrixAccountReady(entry?: {
  connected?: boolean;
  healthState?: string;
  restartPending?: boolean;
  running?: boolean;
}): boolean {
  return Boolean(
    entry?.running === true &&
    entry.connected === true &&
    entry.restartPending !== true &&
    (entry.healthState === undefined || entry.healthState === "healthy"),
  );
}

async function waitForMatrixChannelReady(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
  opts?: {
    pollMs?: number;
    timeoutMs?: number;
  },
) {
  const pollMs = opts?.pollMs ?? 500;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            healthState?: string;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.matrix ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      if (isMatrixAccountReady(match)) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`matrix account "${accountId}" did not become ready`);
}

function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

function buildMatrixReplyArtifact(
  event: MatrixQaObservedEvent,
  token: string,
): MatrixQaReplyArtifact {
  return {
    eventId: event.eventId,
    mentions: event.mentions,
    relatesTo: event.relatesTo,
    sender: event.sender,
    tokenMatched: (event.body ?? "").includes(token),
  };
}

function buildMatrixReplyDetails(label: string, artifact: MatrixQaReplyArtifact) {
  return [
    `${label} event: ${artifact.eventId}`,
    `${label} token matched: ${artifact.tokenMatched ? "yes" : "no"}`,
    `${label} rel_type: ${artifact.relatesTo?.relType ?? "<none>"}`,
    `${label} in_reply_to: ${artifact.relatesTo?.inReplyToId ?? "<none>"}`,
    `${label} is_falling_back: ${artifact.relatesTo?.isFallingBack === true ? "true" : "false"}`,
  ];
}

function assertTopLevelReplyArtifact(label: string, artifact: MatrixQaReplyArtifact) {
  if (!artifact.tokenMatched) {
    throw new Error(`${label} did not contain the expected token`);
  }
  if (artifact.relatesTo !== undefined) {
    throw new Error(`${label} unexpectedly included relation metadata`);
  }
}

function assertThreadReplyArtifact(
  artifact: MatrixQaReplyArtifact,
  params: {
    expectedRootEventId: string;
    label: string;
  },
) {
  if (!artifact.tokenMatched) {
    throw new Error(`${params.label} did not contain the expected token`);
  }
  if (artifact.relatesTo?.relType !== "m.thread") {
    throw new Error(`${params.label} did not use m.thread`);
  }
  if (artifact.relatesTo.eventId !== params.expectedRootEventId) {
    throw new Error(
      `${params.label} targeted ${artifact.relatesTo.eventId ?? "<none>"} instead of ${params.expectedRootEventId}`,
    );
  }
  if (artifact.relatesTo.isFallingBack !== true) {
    throw new Error(`${params.label} did not set is_falling_back`);
  }
  if (!artifact.relatesTo.inReplyToId) {
    throw new Error(`${params.label} did not set m.in_reply_to`);
  }
}

async function runTopLevelMentionScenario(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  since?: string;
  sutUserId: string;
  timeoutMs: number;
  tokenPrefix: string;
}) {
  const client = createMatrixQaClient({
    accessToken: params.driverAccessToken,
    baseUrl: params.baseUrl,
  });
  const token = `${params.tokenPrefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const driverEventId = await client.sendTextMessage({
    body: buildMentionPrompt(params.sutUserId, token),
    mentionUserIds: [params.sutUserId],
    roomId: params.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      (event.body ?? "").includes(token) &&
      event.relatesTo === undefined,
    roomId: params.roomId,
    since: params.since,
    timeoutMs: params.timeoutMs,
  });
  return {
    driverEventId,
    reply: buildMatrixReplyArtifact(matched.event, token),
    since: matched.since,
    token,
  };
}

async function runThreadScenario(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  since?: string;
  sutUserId: string;
  timeoutMs: number;
}) {
  const client = createMatrixQaClient({
    accessToken: params.driverAccessToken,
    baseUrl: params.baseUrl,
  });
  const rootBody = `thread root ${randomUUID().slice(0, 8)}`;
  const rootEventId = await client.sendTextMessage({
    body: rootBody,
    roomId: params.roomId,
  });
  const token = `MATRIX_QA_THREAD_${randomUUID().slice(0, 8).toUpperCase()}`;
  const driverThreadEventId = await client.sendTextMessage({
    body: buildMentionPrompt(params.sutUserId, token),
    mentionUserIds: [params.sutUserId],
    replyToEventId: rootEventId,
    roomId: params.roomId,
    threadRootEventId: rootEventId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      (event.body ?? "").includes(token) &&
      event.relatesTo?.relType === "m.thread" &&
      event.relatesTo.eventId === rootEventId,
    roomId: params.roomId,
    since: params.since,
    timeoutMs: params.timeoutMs,
  });
  return {
    driverEventId: driverThreadEventId,
    reply: buildMatrixReplyArtifact(matched.event, token),
    rootEventId,
    since: matched.since,
    token,
  };
}

async function runThreadIsolationScenario(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  since?: string;
  sutUserId: string;
  timeoutMs: number;
}) {
  const threadPhase = await runThreadScenario(params);
  const topLevelPhase = await runTopLevelMentionScenario({
    baseUrl: params.baseUrl,
    driverAccessToken: params.driverAccessToken,
    observedEvents: params.observedEvents,
    roomId: params.roomId,
    since: threadPhase.since,
    sutUserId: params.sutUserId,
    timeoutMs: params.timeoutMs,
    tokenPrefix: "MATRIX_QA_TOPLEVEL",
  });
  return {
    since: topLevelPhase.since,
    threadPhase,
    topLevelPhase,
  };
}

export async function runMatrixQaLive(params: {
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
  alternateModel?: string;
}): Promise<MatrixQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `matrix-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(params.providerMode ?? "live-frontier");
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds);
  const observedEvents: MatrixQaObservedEvent[] = [];
  const includeObservedEventContent = process.env.OPENCLAW_QA_MATRIX_CAPTURE_CONTENT === "1";
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const runSuffix = randomUUID().slice(0, 8);

  const harness = await startMatrixQaHarness({
    outputDir: path.join(outputDir, "matrix-harness"),
    repoRoot,
  });
  const provisioning: MatrixQaProvisionResult = await (async () => {
    try {
      return await provisionMatrixQaRoom({
        baseUrl: harness.baseUrl,
        driverLocalpart: `qa-driver-${runSuffix}`,
        observerLocalpart: `qa-observer-${runSuffix}`,
        registrationToken: harness.registrationToken,
        roomName: `OpenClaw Matrix QA ${runSuffix}`,
        sutLocalpart: `qa-sut-${runSuffix}`,
      });
    } catch (error) {
      await harness.stop().catch(() => {});
      throw error;
    }
  })();

  const checks: QaReportCheck[] = [
    {
      name: "Matrix harness ready",
      status: "pass",
      details: [
        `image: ${harness.image}`,
        `baseUrl: ${harness.baseUrl}`,
        `serverName: ${harness.serverName}`,
        `roomId: ${provisioning.roomId}`,
      ].join("\n"),
    },
  ];
  const scenarioResults: MatrixQaScenarioResult[] = [];
  const cleanupErrors: string[] = [];
  let canaryArtifact: MatrixQaCanaryArtifact | undefined;
  let gatewayHarness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | null = null;
  let canaryFailed = false;
  let canarySince: string | undefined;

  try {
    gatewayHarness = await startQaLiveLaneGateway({
      repoRoot,
      qaBusBaseUrl: "http://127.0.0.1:43123",
      providerMode,
      primaryModel,
      alternateModel,
      fastMode: params.fastMode,
      controlUiEnabled: false,
      mutateConfig: (cfg) =>
        buildMatrixQaConfig(cfg, {
          driverUserId: provisioning.driver.userId,
          homeserver: harness.baseUrl,
          roomId: provisioning.roomId,
          sutAccessToken: provisioning.sut.accessToken,
          sutAccountId,
          sutDeviceId: provisioning.sut.deviceId,
          sutUserId: provisioning.sut.userId,
        }),
    });
    await waitForMatrixChannelReady(gatewayHarness.gateway, sutAccountId);
    checks.push({
      name: "Matrix channel ready",
      status: "pass",
      details: `accountId: ${sutAccountId}\nuserId: ${provisioning.sut.userId}`,
    });

    try {
      const canaryPrimeClient = createMatrixQaClient({
        accessToken: provisioning.driver.accessToken,
        baseUrl: harness.baseUrl,
      });
      canarySince = await canaryPrimeClient.primeRoom();
      const canary = await runTopLevelMentionScenario({
        baseUrl: harness.baseUrl,
        driverAccessToken: provisioning.driver.accessToken,
        observedEvents,
        roomId: provisioning.roomId,
        since: canarySince,
        sutUserId: provisioning.sut.userId,
        timeoutMs: 45_000,
        tokenPrefix: "MATRIX_QA_CANARY",
      });
      assertTopLevelReplyArtifact("canary reply", canary.reply);
      canaryArtifact = {
        driverEventId: canary.driverEventId,
        reply: canary.reply,
        token: canary.token,
      };
      canarySince = canary.since;
      checks.push({
        name: "Matrix canary",
        status: "pass",
        details: buildMatrixReplyDetails("reply", canary.reply).join("\n"),
      });
    } catch (error) {
      canaryFailed = true;
      checks.push({
        name: "Matrix canary",
        status: "fail",
        details: formatErrorMessage(error),
      });
    }

    if (!canaryFailed) {
      for (const scenario of scenarios) {
        try {
          if (scenario.id === "matrix-thread-follow-up") {
            const result = await runThreadScenario({
              baseUrl: harness.baseUrl,
              driverAccessToken: provisioning.driver.accessToken,
              observedEvents,
              roomId: provisioning.roomId,
              since: canarySince,
              sutUserId: provisioning.sut.userId,
              timeoutMs: scenario.timeoutMs,
            });
            assertThreadReplyArtifact(result.reply, {
              expectedRootEventId: result.rootEventId,
              label: "thread reply",
            });
            canarySince = result.since;
            scenarioResults.push({
              artifacts: {
                driverEventId: result.driverEventId,
                reply: result.reply,
                rootEventId: result.rootEventId,
                token: result.token,
              },
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: [
                `root event: ${result.rootEventId}`,
                `driver thread event: ${result.driverEventId}`,
                ...buildMatrixReplyDetails("reply", result.reply),
              ].join("\n"),
            });
            continue;
          }

          const result = await runThreadIsolationScenario({
            baseUrl: harness.baseUrl,
            driverAccessToken: provisioning.driver.accessToken,
            observedEvents,
            roomId: provisioning.roomId,
            since: canarySince,
            sutUserId: provisioning.sut.userId,
            timeoutMs: scenario.timeoutMs,
          });
          assertThreadReplyArtifact(result.threadPhase.reply, {
            expectedRootEventId: result.threadPhase.rootEventId,
            label: "thread isolation reply",
          });
          assertTopLevelReplyArtifact("top-level follow-up reply", result.topLevelPhase.reply);
          canarySince = result.since;
          scenarioResults.push({
            artifacts: {
              threadDriverEventId: result.threadPhase.driverEventId,
              threadReply: result.threadPhase.reply,
              threadRootEventId: result.threadPhase.rootEventId,
              threadToken: result.threadPhase.token,
              topLevelDriverEventId: result.topLevelPhase.driverEventId,
              topLevelReply: result.topLevelPhase.reply,
              topLevelToken: result.topLevelPhase.token,
            },
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: [
              `thread root event: ${result.threadPhase.rootEventId}`,
              `thread driver event: ${result.threadPhase.driverEventId}`,
              ...buildMatrixReplyDetails("thread reply", result.threadPhase.reply),
              `top-level driver event: ${result.topLevelPhase.driverEventId}`,
              ...buildMatrixReplyDetails("top-level reply", result.topLevelPhase.reply),
            ].join("\n"),
          });
        } catch (error) {
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "fail",
            details: formatErrorMessage(error),
          });
        }
      }
    }
  } finally {
    if (gatewayHarness) {
      try {
        await gatewayHarness.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupErrors, "live gateway cleanup", error);
      }
    }
    try {
      await harness.stop();
    } catch (error) {
      appendLiveLaneIssue(cleanupErrors, "Matrix harness cleanup", error);
    }
  }
  if (cleanupErrors.length > 0) {
    checks.push({
      name: "Matrix cleanup",
      status: "fail",
      details: cleanupErrors.join("\n"),
    });
  }

  const finishedAtDate = new Date();
  const finishedAt = finishedAtDate.toISOString();
  const reportPath = path.join(outputDir, "matrix-qa-report.md");
  const summaryPath = path.join(outputDir, "matrix-qa-summary.json");
  const observedEventsPath = path.join(outputDir, "matrix-qa-observed-events.json");
  const report = renderQaMarkdownReport({
    title: "Matrix QA Report",
    startedAt: startedAtDate,
    finishedAt: finishedAtDate,
    checks,
    scenarios: scenarioResults.map((scenario) => ({
      details: scenario.details,
      name: scenario.title,
      status: scenario.status,
    })),
    notes: [
      `roomId: ${provisioning.roomId}`,
      `driver: ${provisioning.driver.userId}`,
      `observer: ${provisioning.observer.userId}`,
      `sut: ${provisioning.sut.userId}`,
      `homeserver: ${harness.baseUrl}`,
      `image: ${harness.image}`,
    ],
  });
  const summary: MatrixQaSummary = {
    checks,
    counts: {
      total: checks.length + scenarioResults.length,
      passed:
        checks.filter((check) => check.status === "pass").length +
        scenarioResults.filter((scenario) => scenario.status === "pass").length,
      failed:
        checks.filter((check) => check.status === "fail").length +
        scenarioResults.filter((scenario) => scenario.status === "fail").length,
    },
    finishedAt,
    harness: {
      baseUrl: harness.baseUrl,
      composeFile: harness.composeFile,
      image: harness.image,
      roomId: provisioning.roomId,
      serverName: harness.serverName,
    },
    canary: canaryArtifact,
    observedEventCount: observedEvents.length,
    observedEventsPath,
    reportPath,
    scenarios: scenarioResults,
    startedAt,
    summaryPath,
    sutAccountId,
    userIds: {
      driver: provisioning.driver.userId,
      observer: provisioning.observer.userId,
      sut: provisioning.sut.userId,
    },
  };

  await fs.writeFile(reportPath, `${report}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.writeFile(
    observedEventsPath,
    `${JSON.stringify(
      buildObservedEventsArtifact({
        includeContent: includeObservedEventContent,
        observedEvents,
      }),
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const failedChecks = checks.filter((check) => check.status === "fail");
  const failedScenarios = scenarioResults.filter((scenario) => scenario.status === "fail");
  const artifactPaths = {
    report: reportPath,
    summary: summaryPath,
    observedEvents: observedEventsPath,
  };
  if (failedChecks.length > 0 || failedScenarios.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Matrix QA failed.",
        details: [
          ...failedChecks.map((check) => `check ${check.name}: ${check.details ?? "failed"}`),
          ...failedScenarios.map((scenario) => `scenario ${scenario.id}: ${scenario.details}`),
        ],
        artifacts: artifactPaths,
      }),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Matrix QA cleanup failed after artifacts were written.",
        details: cleanupErrors,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    observedEventsPath,
    outputDir,
    reportPath,
    scenarios: scenarioResults,
    summaryPath,
  };
}

export const __testing = {
  MATRIX_QA_SCENARIOS,
  buildMatrixQaConfig,
  buildMentionPrompt,
  buildObservedEventsArtifact,
  findScenario,
  isMatrixAccountReady,
  waitForMatrixChannelReady,
};
