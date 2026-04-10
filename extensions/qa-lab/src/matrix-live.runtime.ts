import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "./gateway-child.js";
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
  id: "matrix-thread-follow-up";
  timeoutMs: number;
  title: string;
};

type MatrixQaScenarioResult = {
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
  observedEventsPath: string;
  reportPath: string;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  summaryPath: string;
  sutAccountId: string;
  userIds: {
    driver: string;
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

async function waitForMatrixChannelReady(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
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
      if (
        match?.running === true &&
        match.connected === true &&
        match.restartPending !== true &&
        (match.healthState === undefined || match.healthState === "healthy")
      ) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`matrix account "${accountId}" did not become ready`);
}

function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with exactly: ${token}`;
}

async function runMatrixCanary(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  sutUserId: string;
}) {
  const client = createMatrixQaClient({
    accessToken: params.driverAccessToken,
    baseUrl: params.baseUrl,
  });
  let since = await client.primeRoom();
  const token = `MATRIX_QA_CANARY_${randomUUID().slice(0, 8).toUpperCase()}`;
  await client.sendTextMessage({
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
    since,
    timeoutMs: 45_000,
  });
  since = matched.since;
  return {
    event: matched.event,
    since,
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
    driverThreadEventId,
    replyEvent: matched.event,
    rootEventId,
    since: matched.since,
    token,
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
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | null = null;
  let canaryFailed = false;
  let canarySince: string | undefined;

  try {
    gateway = await startQaGatewayChild({
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
    await waitForMatrixChannelReady(gateway, sutAccountId);
    checks.push({
      name: "Matrix channel ready",
      status: "pass",
      details: `accountId: ${sutAccountId}\nuserId: ${provisioning.sut.userId}`,
    });

    try {
      const canary = await runMatrixCanary({
        baseUrl: harness.baseUrl,
        driverAccessToken: provisioning.driver.accessToken,
        observedEvents,
        roomId: provisioning.roomId,
        sutUserId: provisioning.sut.userId,
      });
      canarySince = canary.since;
      checks.push({
        name: "Matrix canary",
        status: "pass",
        details: `reply event ${canary.event.eventId} contained ${canary.token}`,
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
          const result = await runThreadScenario({
            baseUrl: harness.baseUrl,
            driverAccessToken: provisioning.driver.accessToken,
            observedEvents,
            roomId: provisioning.roomId,
            since: canarySince,
            sutUserId: provisioning.sut.userId,
            timeoutMs: scenario.timeoutMs,
          });
          canarySince = result.since;
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: [
              `root event: ${result.rootEventId}`,
              `driver thread event: ${result.driverThreadEventId}`,
              `sut reply event: ${result.replyEvent.eventId}`,
              `reply rel_type: ${result.replyEvent.relatesTo?.relType ?? "<none>"}`,
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
    await gateway?.stop().catch(() => {});
    await harness.stop().catch(() => {});
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
    observedEventsPath,
    reportPath,
    scenarios: scenarioResults,
    startedAt,
    summaryPath,
    sutAccountId,
    userIds: {
      driver: provisioning.driver.userId,
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
  if (failedChecks.length > 0 || failedScenarios.length > 0) {
    throw new Error(
      [
        "Matrix QA failed.",
        ...failedChecks.map((check) => `check ${check.name}: ${check.details ?? "failed"}`),
        ...failedScenarios.map((scenario) => `scenario ${scenario.id}: ${scenario.details}`),
        "Artifacts:",
        `- report: ${reportPath}`,
        `- summary: ${summaryPath}`,
        `- observedEvents: ${observedEventsPath}`,
      ].join("\n"),
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
  buildObservedEventsArtifact,
  findScenario,
  waitForMatrixChannelReady,
};
