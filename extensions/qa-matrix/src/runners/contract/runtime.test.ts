// Qa Matrix tests cover runtime plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { renderQaMarkdownReport } from "openclaw/plugin-sdk/qa-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixQaConfig,
  buildMatrixQaConfigSnapshot,
  summarizeMatrixQaConfigSnapshot,
} from "../../substrate/config.js";
import { resolveMatrixQaModels } from "./model-selection.js";
import {
  createMatrixQaRunDeadline,
  patchMatrixQaGatewayConfig,
  readMatrixQaGatewayDebugSummary,
  resolveMatrixQaCanaryTimeoutMs,
  resolveMatrixQaOutputDir,
  waitForMatrixChannelReady,
  withMatrixQaRunDeadline,
  writeMatrixQaProgress,
} from "./runtime-control.js";
import {
  getMatrixQaScenarioRestartReadyTimeoutMs,
  resolveMatrixQaGatewayModels,
  scheduleMatrixQaScenariosInCatalogOrder,
  selectMatrixQaCanaryProviderMode,
} from "./runtime-planning.js";
import { buildMatrixQaSummary } from "./runtime-summary.js";
import { MATRIX_QA_SCENARIOS, findMatrixQaScenarios } from "./scenarios.js";

const liveTesting = {
  MATRIX_QA_SCENARIOS,
  buildMatrixQaConfig,
  buildMatrixQaConfigSnapshot,
  buildMatrixQaSummary,
  createMatrixQaRunDeadline,
  findMatrixQaScenarios,
  getMatrixQaScenarioRestartReadyTimeoutMs,
  patchMatrixQaGatewayConfig,
  readMatrixQaGatewayDebugSummary,
  resolveMatrixQaCanaryTimeoutMs,
  resolveMatrixQaGatewayModels,
  resolveMatrixQaModels,
  resolveMatrixQaOutputDir,
  scheduleMatrixQaScenariosInCatalogOrder,
  selectMatrixQaCanaryProviderMode,
  summarizeMatrixQaConfigSnapshot,
  waitForMatrixChannelReady,
  withMatrixQaRunDeadline,
  writeMatrixQaProgress,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type MatrixQaSummaryInput = Parameters<typeof liveTesting.buildMatrixQaSummary>[0];
type MatrixQaSummaryInputOverrides = Partial<Omit<MatrixQaSummaryInput, "timings">> & {
  timings?: Partial<MatrixQaSummaryInput["timings"]>;
};

function buildMatrixQaSummaryInput(
  overrides: MatrixQaSummaryInputOverrides = {},
): MatrixQaSummaryInput {
  const timings: MatrixQaSummaryInput["timings"] = {
    artifactWriteMs: 5,
    canaryMs: 40,
    harnessBootMs: 100,
    initialGatewayBootMs: 200,
    provisioningMs: 300,
    scenarioGatewayBootMs: 50,
    scenarioRestartGatewayMs: 60,
    scenarioTransportInterruptMs: 70,
    scenarios: [],
    totalMs: 825,
    ...overrides.timings,
  };

  return {
    artifactPaths: {
      observedEvents: "/tmp/observed.json",
      report: "/tmp/report.md",
      routeStateManifest: "/tmp/route-state.json",
      summary: "/tmp/summary.json",
    },
    checks: [{ name: "Matrix harness ready", status: "pass" }],
    config: {
      default: liveTesting.buildMatrixQaConfigSnapshot({
        driverUserId: "@driver:matrix-qa.test",
        observerUserId: "@observer:matrix-qa.test",
        sutUserId: "@sut:matrix-qa.test",
        topology: {
          defaultRoomId: "!room:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
      scenarios: [],
    },
    differentialProbe: {
      profile: "matrix-qa-v1",
      steps: [],
      sync: { continuity: true, incrementalStatus: 200, initialStatus: 200 },
    },
    finishedAt: "2026-04-10T10:05:00.000Z",
    harness: {
      baseUrl: "http://127.0.0.1:28008/",
      composeFile: "/tmp/docker-compose.yml",
      dmRoomIds: [],
      image: "ghcr.io/matrix-construct/tuwunel:v1.5.1",
      roomId: "!room:matrix-qa.test",
      roomIds: ["!room:matrix-qa.test"],
      serverName: "matrix-qa.test",
    },
    observedEventCount: 4,
    scenarios: [],
    startedAt: "2026-04-10T10:00:00.000Z",
    sutAccountId: "sut",
    userIds: {
      driver: "@driver:matrix-qa.test",
      observer: "@observer:matrix-qa.test",
      sut: "@sut:matrix-qa.test",
    },
    ...overrides,
    timings,
  };
}

describe("matrix live qa runtime", () => {
  it("preserves a failed differential probe check without a probe payload", () => {
    const summary = liveTesting.buildMatrixQaSummary(
      buildMatrixQaSummaryInput({
        checks: [
          { name: "Matrix harness ready", status: "pass" },
          {
            details: "missing-state response did not return M_NOT_FOUND",
            name: "Matrix differential probe",
            status: "fail",
          },
        ],
        differentialProbe: undefined,
      }),
    );

    expect(summary.differentialProbe).toBeUndefined();
    expect(summary.counts).toEqual({ failed: 1, passed: 1, total: 2 });
  });

  it("uses unique default artifact directories", () => {
    const repoRoot = "/repo";
    const firstOutputDir = liveTesting.resolveMatrixQaOutputDir({ repoRoot });
    const secondOutputDir = liveTesting.resolveMatrixQaOutputDir({ repoRoot });

    expect(path.dirname(firstOutputDir)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstOutputDir)).toMatch(/^matrix-[a-z0-9]+-[a-f0-9]{8}$/u);
    expect(secondOutputDir).not.toBe(firstOutputDir);
    expect(liveTesting.resolveMatrixQaOutputDir({ outputDir: ".artifacts/custom", repoRoot })).toBe(
      ".artifacts/custom",
    );
  });

  it("prints Matrix QA progress by default for non-interactive runs", () => {
    const previous = process.env.OPENCLAW_QA_MATRIX_PROGRESS;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env.OPENCLAW_QA_MATRIX_PROGRESS;
    try {
      liveTesting.writeMatrixQaProgress("suite start");
      expect(write).toHaveBeenCalledWith("[matrix-qa] suite start\n");
      write.mockClear();
      process.env.OPENCLAW_QA_MATRIX_PROGRESS = "0";
      liveTesting.writeMatrixQaProgress("suite hidden");
      expect(write).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MATRIX_PROGRESS;
      } else {
        process.env.OPENCLAW_QA_MATRIX_PROGRESS = previous;
      }
    }
  });

  it("summarizes relevant gateway stderr lines for Matrix QA failures", async () => {
    const debugDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-gateway-debug-"));
    try {
      await writeFile(
        path.join(debugDir, "gateway.stderr.log"),
        [
          "normal gateway progress",
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          "[agent/embedded] embedded run failover decision: stage=prompt decision=surface_error reason=auth",
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        ].join("\n"),
      );
      const summary = await liveTesting.readMatrixQaGatewayDebugSummary(debugDir);

      expect(summary).toContain("gateway stderr tail:");
      expect(summary).toContain("Authorization: Bearer");
      expect(summary).toContain("reason=auth");
      expect(summary).toContain("unexpected status 401 Unauthorized");
      expect(summary).not.toContain("normal gateway progress");
      expect(summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    } finally {
      await rm(debugDir, { force: true, recursive: true });
    }
  });

  it("skips missing gateway stderr summaries", async () => {
    const debugDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-gateway-debug-"));
    try {
      await expect(liveTesting.readMatrixQaGatewayDebugSummary(debugDir)).resolves.toBeUndefined();
    } finally {
      await rm(debugDir, { force: true, recursive: true });
    }
  });

  it("normalizes the Matrix QA hard timeout env", () => {
    const previous = process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS;
    try {
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "12345";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(12345);
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "+012345";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(12345);
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "nope";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(30 * 60_000);
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "1e3";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(30 * 60_000);
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "1.5";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(30 * 60_000);
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = previous;
      }
    }
  });

  it("does not start Matrix QA work after the hard run deadline expires", async () => {
    const task = vi.fn(async () => "started");
    vi.spyOn(Date, "now").mockReturnValue(1_001);

    await expect(
      liveTesting.withMatrixQaRunDeadline(
        {
          deadlineMs: 1_000,
          timeoutMs: 30_000,
        },
        "Matrix scenario late",
        task,
      ),
    ).rejects.toThrow(/Matrix scenario late not started because Matrix QA run timed out/u);
    expect(task).not.toHaveBeenCalled();
  });

  it("starts Matrix QA work while the hard run budget remains", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    await expect(
      liveTesting.withMatrixQaRunDeadline(
        {
          deadlineMs: 1_250,
          timeoutMs: 30_000,
        },
        "Matrix canary",
        async () => "started",
      ),
    ).resolves.toBe("started");
  });

  it("normalizes the Matrix QA canary timeout env", () => {
    const previous = process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS;
    try {
      delete process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS;
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(45_000);
      process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = "90000";
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(90_000);
      process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = "+090000";
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(90_000);
      process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = "nope";
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(45_000);
      process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = "0x1000";
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(45_000);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = previous;
      }
    }
  });

  it("uses a scenario provider override for the canary only when the whole run is pinned", () => {
    const blockStreamingScenario = liveTesting.MATRIX_QA_SCENARIOS.find(
      (scenario) => scenario.id === "matrix-room-block-streaming",
    );
    const threadScenario = liveTesting.MATRIX_QA_SCENARIOS.find(
      (scenario) => scenario.id === "matrix-thread-root-preservation",
    );
    expect(blockStreamingScenario).toBeDefined();
    expect(threadScenario).toBeDefined();

    const pinnedSchedule = liveTesting.scheduleMatrixQaScenariosInCatalogOrder([
      blockStreamingScenario!,
    ]);
    expect(liveTesting.selectMatrixQaCanaryProviderMode(pinnedSchedule)).toBe("mock-openai");

    const mixedSchedule = liveTesting.scheduleMatrixQaScenariosInCatalogOrder([
      threadScenario!,
      blockStreamingScenario!,
    ]);
    expect(liveTesting.selectMatrixQaCanaryProviderMode(mixedSchedule)).toBeUndefined();
  });

  it("preserves explicit model pins when a scenario keeps the suite provider", () => {
    const defaultModels = {
      alternateModel: "mock-openai/custom-alt",
      primaryModel: "mock-openai/custom",
      providerMode: "mock-openai" as const,
    };

    expect(
      liveTesting.resolveMatrixQaGatewayModels({
        defaultModels,
        providerMode: "mock-openai",
      }),
    ).toEqual(defaultModels);
  });

  it("injects a temporary Matrix account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
    };

    const next = liveTesting.buildMatrixQaConfig(baseCfg, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "syt_sut",
      sutAccountId: "sut",
      sutDeviceId: "DEVICE123",
      sutUserId: "@sut:matrix-qa.test",
      topology: {
        defaultRoomId: "!room:matrix-qa.test",
        defaultRoomKey: "main",
        rooms: [
          {
            key: "main",
            kind: "group",
            memberRoles: ["driver", "observer", "sut"],
            memberUserIds: [
              "@driver:matrix-qa.test",
              "@observer:matrix-qa.test",
              "@sut:matrix-qa.test",
            ],
            name: "Matrix QA",
            requireMention: true,
            roomId: "!room:matrix-qa.test",
          },
        ],
      },
    });

    expect(next.plugins?.allow).toContain("matrix");
    expect(next.plugins?.entries?.matrix).toEqual({ enabled: true });
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(next.channels?.matrix).toEqual({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          accessToken: "syt_sut",
          deviceId: "DEVICE123",
          dm: { enabled: false },
          enabled: true,
          encryption: false,
          groupAllowFrom: ["@driver:matrix-qa.test"],
          groupPolicy: "allowlist",
          groups: {
            "!room:matrix-qa.test": {
              enabled: true,
              requireMention: true,
            },
          },
          homeserver: "http://127.0.0.1:28008/",
          network: {
            dangerouslyAllowPrivateNetwork: true,
          },
          replyToMode: "off",
          threadReplies: "inbound",
          userId: "@sut:matrix-qa.test",
        },
      },
    });
  });

  it("derives Matrix DM + multi-room config from provisioned topology", () => {
    const next = liveTesting.buildMatrixQaConfig(
      {},
      {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        observerUserId: "@observer:matrix-qa.test",
        sutAccessToken: "syt_sut",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology: {
          defaultRoomId: "!room-a:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: "main",
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Matrix QA A",
              requireMention: true,
              roomId: "!room-a:matrix-qa.test",
            },
            {
              key: "secondary",
              kind: "group",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "Matrix QA B",
              requireMention: false,
              roomId: "!room-b:matrix-qa.test",
            },
            {
              key: "sut-dm",
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "Matrix QA DM",
              requireMention: false,
              roomId: "!dm:matrix-qa.test",
            },
          ],
        },
      },
    );

    expect(next.channels?.matrix?.accounts?.sut?.dm).toEqual({
      allowFrom: ["@driver:matrix-qa.test"],
      enabled: true,
      policy: "allowlist",
    });
    expect(next.channels?.matrix?.accounts?.sut?.groups).toEqual({
      "!room-a:matrix-qa.test": {
        enabled: true,
        requireMention: true,
      },
      "!room-b:matrix-qa.test": {
        enabled: true,
        requireMention: false,
      },
    });
  });

  it("records default and per-scenario Matrix config snapshots in the summary", () => {
    const summary = liveTesting.buildMatrixQaSummary({
      artifactPaths: {
        observedEvents: "/tmp/observed.json",
        report: "/tmp/report.md",
        routeStateManifest: "/tmp/route-state.json",
        summary: "/tmp/summary.json",
      },
      checks: [{ name: "Matrix harness ready", status: "pass" }],
      config: {
        default: liveTesting.buildMatrixQaConfigSnapshot({
          driverUserId: "@driver:matrix-qa.test",
          observerUserId: "@observer:matrix-qa.test",
          sutUserId: "@sut:matrix-qa.test",
          topology: {
            defaultRoomId: "!room:matrix-qa.test",
            defaultRoomKey: "main",
            rooms: [
              {
                key: "main",
                kind: "group",
                memberRoles: ["driver", "observer", "sut"],
                memberUserIds: [
                  "@driver:matrix-qa.test",
                  "@observer:matrix-qa.test",
                  "@sut:matrix-qa.test",
                ],
                name: "Matrix QA",
                requireMention: true,
                roomId: "!room:matrix-qa.test",
              },
            ],
          },
        }),
        scenarios: [
          {
            id: "matrix-room-block-streaming",
            title: "Matrix block streaming",
            config: liveTesting.buildMatrixQaConfigSnapshot({
              driverUserId: "@driver:matrix-qa.test",
              observerUserId: "@observer:matrix-qa.test",
              overrides: {
                blockStreaming: true,
              },
              sutUserId: "@sut:matrix-qa.test",
              topology: {
                defaultRoomId: "!room:matrix-qa.test",
                defaultRoomKey: "main",
                rooms: [
                  {
                    key: "main",
                    kind: "group",
                    memberRoles: ["driver", "observer", "sut"],
                    memberUserIds: [
                      "@driver:matrix-qa.test",
                      "@observer:matrix-qa.test",
                      "@sut:matrix-qa.test",
                    ],
                    name: "Matrix QA",
                    requireMention: true,
                    roomId: "!room:matrix-qa.test",
                  },
                ],
              },
            }),
          },
        ],
      },
      differentialProbe: {
        profile: "matrix-qa-v1",
        steps: [],
        sync: { continuity: true, incrementalStatus: 200, initialStatus: 200 },
      },
      finishedAt: "2026-04-10T10:05:00.000Z",
      harness: {
        baseUrl: "http://127.0.0.1:28008/",
        composeFile: "/tmp/docker-compose.yml",
        dmRoomIds: [],
        image: "ghcr.io/matrix-construct/tuwunel:v1.5.1",
        roomId: "!room:matrix-qa.test",
        roomIds: ["!room:matrix-qa.test"],
        serverName: "matrix-qa.test",
      },
      observedEventCount: 0,
      scenarios: [],
      startedAt: "2026-04-10T10:00:00.000Z",
      sutAccountId: "sut",
      timings: {
        artifactWriteMs: 5,
        canaryMs: 40,
        harnessBootMs: 100,
        initialGatewayBootMs: 200,
        provisioningMs: 300,
        scenarioGatewayBootMs: 50,
        scenarioRestartGatewayMs: 60,
        scenarioTransportInterruptMs: 70,
        scenarios: [],
        totalMs: 825,
      },
      userIds: {
        driver: "@driver:matrix-qa.test",
        observer: "@observer:matrix-qa.test",
        sut: "@sut:matrix-qa.test",
      },
    });
    const config = summary.config;
    expect(config.default.replyToMode).toBe("off");
    expect(config.default.threadReplies).toBe("inbound");
    expect(config.scenarios).toHaveLength(1);
    expect(config.scenarios[0]?.id).toBe("matrix-room-block-streaming");
    expect(config.scenarios[0]?.config.blockStreaming).toBe(true);
  });

  it("keeps failing Matrix scenario details and timings complete in summary + report output", () => {
    const summary = liveTesting.buildMatrixQaSummary(
      buildMatrixQaSummaryInput({
        observedEventCount: 6,
        scenarios: [
          {
            id: "matrix-reaction-not-a-reply",
            title: "Matrix reactions do not trigger a fresh bot reply",
            status: "fail",
            details: [
              "unexpected SUT reply after reaction from @driver:matrix-qa.test",
              "reaction event: $reaction",
              "unexpected reply event: $reply",
            ].join("\n"),
          },
        ],
        timings: {
          scenarios: [
            {
              durationMs: 8_000,
              gatewayBootMs: 0,
              gatewayRestartMs: 0,
              id: "matrix-reaction-not-a-reply",
              title: "Matrix reactions do not trigger a fresh bot reply",
              transportInterruptMs: 0,
            },
          ],
          totalMs: 825,
        },
      }),
    );

    expect(summary.counts.total).toBe(2);
    expect(summary.counts.passed).toBe(1);
    expect(summary.counts.failed).toBe(1);
    expect(summary.scenarios[0]?.id).toBe("matrix-reaction-not-a-reply");
    expect(summary.scenarios[0]?.status).toBe("fail");
    expect(summary.scenarios[0]?.details).toContain("reaction event: $reaction");
    expect(summary.timings.scenarios[0]?.id).toBe("matrix-reaction-not-a-reply");
    expect(summary.timings.scenarios[0]?.durationMs).toBe(8_000);

    const report = renderQaMarkdownReport({
      title: "Matrix QA Report",
      startedAt: new Date(summary.startedAt),
      finishedAt: new Date(summary.finishedAt),
      checks: summary.checks,
      scenarios: summary.scenarios.map((scenario) => ({
        details: scenario.details,
        name: scenario.title,
        status: scenario.status,
      })),
      notes: [`observed events: ${summary.observedEventsPath}`],
    });

    expect(report).toContain("### Matrix reactions do not trigger a fresh bot reply");
    expect(report).toContain("unexpected SUT reply after reaction from @driver:matrix-qa.test");
    expect(report).toContain("reaction event: $reaction");
    expect(report).toContain("observed events: /tmp/observed.json");
  });

  it("groups Matrix scenario execution by gateway config while preserving tail scenarios", () => {
    const scenarios = liveTesting.findMatrixQaScenarios([
      "matrix-thread-root-preservation",
      "matrix-e2ee-cli-encryption-setup-multi-account",
      "matrix-reaction-notification",
      "matrix-e2ee-cli-setup-then-gateway-reply",
      "matrix-e2ee-cli-self-verification",
      "matrix-e2ee-wrong-account-recovery-key",
    ]);

    expect(
      liveTesting
        .scheduleMatrixQaScenariosInCatalogOrder(scenarios)
        .map(({ scenario }) => scenario.id),
    ).toEqual([
      "matrix-thread-root-preservation",
      "matrix-reaction-notification",
      "matrix-e2ee-cli-self-verification",
      "matrix-e2ee-cli-encryption-setup-multi-account",
      "matrix-e2ee-cli-setup-then-gateway-reply",
      "matrix-e2ee-wrong-account-recovery-key",
    ]);
  });

  it("uses the scenario timeout for post-restart Matrix readiness", () => {
    expect(
      liveTesting.getMatrixQaScenarioRestartReadyTimeoutMs({
        timeoutMs: 180_000,
      }),
    ).toBe(180_000);
  });

  it("retries Matrix gateway config patches after a stale config hash", async () => {
    const patch = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };
    const gateway = {
      call: vi
        .fn()
        .mockResolvedValueOnce({ hash: "hash-old" })
        .mockRejectedValueOnce(
          new Error("config changed since last load; re-run config.get and retry"),
        )
        .mockResolvedValueOnce({ hash: "hash-fresh" })
        .mockResolvedValueOnce(undefined),
    };

    await liveTesting.patchMatrixQaGatewayConfig({
      gateway: gateway as never,
      patch,
      replacePaths: ["channels.matrix.accounts.sut.groupAllowFrom"],
      restartDelayMs: 250,
    });

    expect(gateway.call).toHaveBeenNthCalledWith(1, "config.get", {}, { timeoutMs: 60_000 });
    expect(gateway.call).toHaveBeenNthCalledWith(
      2,
      "config.patch",
      {
        baseHash: "hash-old",
        raw: JSON.stringify(patch, null, 2),
        replacePaths: ["channels.matrix.accounts.sut.groupAllowFrom"],
        restartDelayMs: 250,
      },
      { timeoutMs: 60_000 },
    );
    expect(gateway.call).toHaveBeenNthCalledWith(3, "config.get", {}, { timeoutMs: 60_000 });
    expect(gateway.call).toHaveBeenNthCalledWith(
      4,
      "config.patch",
      {
        baseHash: "hash-fresh",
        raw: JSON.stringify(patch, null, 2),
        replacePaths: ["channels.matrix.accounts.sut.groupAllowFrom"],
        restartDelayMs: 250,
      },
      { timeoutMs: 60_000 },
    );
  });

  it("waits past not-ready Matrix status snapshots until the account is really ready", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: false }],
          },
        })
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: true, restartPending: true }],
          },
        })
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: true }],
          },
        }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 1_000,
      pollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);
    await expect(waitPromise).resolves.toBeUndefined();
    expect(gateway.call).toHaveBeenCalledTimes(3);
  });

  it("fails readiness when the Matrix account never reaches a healthy connected state", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi.fn().mockResolvedValue({
        channelAccounts: {
          matrix: [{ accountId: "sut", running: true, connected: true, healthState: "degraded" }],
        },
      }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 250,
      pollMs: 100,
    });
    const expectation = expect(waitPromise).rejects.toThrow(
      'matrix account "sut" did not become ready',
    );
    await vi.advanceTimersByTimeAsync(300);
    await expectation;
  });

  it("caps Matrix readiness status RPCs and sleeps to the remaining timeout budget", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi.fn().mockResolvedValue({
        channelAccounts: {
          matrix: [{ accountId: "sut", running: true, connected: true, healthState: "degraded" }],
        },
      }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 250,
      pollMs: 1_000,
    });
    const expectation = expect(waitPromise).rejects.toThrow(
      'matrix account "sut" did not become ready',
    );
    await vi.advanceTimersByTimeAsync(250);

    await expectation;
    expect(gateway.call).toHaveBeenCalledTimes(1);
    expect(gateway.call).toHaveBeenCalledWith(
      "channels.status",
      { probe: false, timeoutMs: 250 },
      { timeoutMs: 250 },
    );
  });
});
