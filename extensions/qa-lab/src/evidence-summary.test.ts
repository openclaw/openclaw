// Qa Lab tests cover QA evidence summary behavior.
import { execFileSync } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  buildPlaywrightEvidenceSummary,
  buildQaOccurrenceEvidenceSummary,
  buildQaSuiteEvidenceSummary,
  buildScriptEvidenceSummary,
  buildVitestEvidenceSummary,
  getEffectiveQaEvidenceEntries,
  mergeQaEvidenceSummaries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceIdentity,
  type QaEvidenceOccurrence,
  type QaEvidenceSummaryV3Entry,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaProviderMode } from "./providers/index.js";

const providerIdentityCases: {
  name: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  providerId?: string;
  expectedId: string;
  expectedName: string | null;
}[] = [
  {
    name: "known live provider with unknown model",
    primaryModel: "",
    providerMode: "live-frontier",
    providerId: "openai",
    expectedId: "openai",
    expectedName: null,
  },
  {
    name: "trimmed live fallback",
    primaryModel: "",
    providerMode: "live-frontier",
    providerId: "  custom  ",
    expectedId: "custom",
    expectedName: null,
  },
  {
    name: "explicit model wins conflicting fallback",
    primaryModel: "custom/model",
    providerMode: "live-frontier",
    providerId: "openai",
    expectedId: "custom",
    expectedName: "model",
  },
  {
    name: "omitted fallback",
    primaryModel: "",
    providerMode: "live-frontier",
    expectedId: "live-frontier",
    expectedName: null,
  },
  {
    name: "blank fallback",
    primaryModel: "",
    providerMode: "live-frontier",
    providerId: "   ",
    expectedId: "live-frontier",
    expectedName: null,
  },
  ...(["mock-openai", "aimock"] as const).flatMap((providerMode) => [
    {
      name: `${providerMode} ignores fallback with unknown model`,
      primaryModel: "",
      providerMode,
      providerId: "custom",
      expectedId: providerMode === "mock-openai" ? "openai" : "aimock",
      expectedName: null,
    },
    {
      name: `${providerMode} preserves model identity`,
      primaryModel: "custom/model",
      providerMode,
      providerId: "openai",
      expectedId: "custom",
      expectedName: "model",
    },
  ]),
];

describe("evidence summary", () => {
  for (const testCase of providerIdentityCases) {
    it(`provider identity fallback: ${testCase.name}`, () => {
      const { primaryModel, providerMode, providerId, expectedId, expectedName } = testCase;
      const evidence = buildScriptEvidenceSummary({
        artifactPaths: [],
        generatedAt: "2026-09-10T00:00:00.000Z",
        primaryModel,
        providerMode,
        providerId,
        targets: [{ id: "provider-identity", title: "Provider identity", sourcePath: "probe.ts" }],
        results: [
          { id: "provider-identity", status: "blocked", failureMessage: "missing candidate" },
        ],
      });

      expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
      expect(evidence.schemaVersion).toBe(2);
      expect(evidence.entries[0]?.execution?.provider).toEqual({
        id: expectedId,
        model: { name: expectedName, ref: primaryModel || null },
        ...(providerMode === "live-frontier"
          ? { live: true, auth: providerMode }
          : { live: false, fixture: providerMode }),
      });
      expect(evidence.entries[0]?.result).toEqual({
        status: "blocked",
        failure: { reason: "missing candidate" },
      });
    });
  }

  it("provider identity fallback: slim evidence still omits execution", () => {
    const evidence = buildScriptEvidenceSummary({
      artifactPaths: [],
      evidenceMode: "slim",
      generatedAt: "2026-09-10T00:00:00.000Z",
      primaryModel: "",
      providerMode: "live-frontier",
      providerId: "openai",
      targets: [{ id: "provider-identity", title: "Provider identity", sourcePath: "probe.ts" }],
      results: [
        { id: "provider-identity", status: "blocked", failureMessage: "missing candidate" },
      ],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.evidenceMode).toBe("slim");
    expect(evidence.entries[0]).not.toHaveProperty("execution");
    expect(evidence.entries[0]?.result.status).toBe("blocked");
  });

  it("builds QA suite evidence entries from catalog metadata", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [
        { kind: "summary", path: "qa-suite-summary.json" },
        { kind: "report", path: "qa-suite-report.md" },
      ],
      scenarioDefinitions: [
        {
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.yaml",
          surface: "dm",
          coverage: {
            primary: ["channels.dm"],
            secondary: ["channels.qa-channel"],
          },
          runtimePairLane: "core",
          docsRefs: ["docs/channels/qa-channel.md"],
          codeRefs: ["extensions/qa-channel/src/gateway.ts"],
        },
      ],
      channelId: "qa-channel",
      channelDriver: "local-shim",
      env: {
        OPENCLAW_QA_CHANNEL_DRIVER: "local-shim",
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.evidenceMode).toBe("full");
    expect(evidence.profile).toBeUndefined();
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "qa-scenario",
        id: "dm-chat-baseline",
        title: "DM baseline conversation",
        source: {
          path: "qa/scenarios/channels/dm-chat-baseline.yaml",
        },
      },
      coverage: [
        {
          id: "channels.dm",
          role: "primary",
        },
        {
          id: "channels.qa-channel",
          role: "secondary",
        },
      ],
      refs: [
        {
          kind: "docs",
          path: "docs/channels/qa-channel.md",
        },
        {
          kind: "code",
          path: "extensions/qa-channel/src/gateway.ts",
        },
      ],
      runtimePairLane: "core",
      execution: {
        runner: "host",
        provider: {
          id: "openai",
          live: false,
          model: {
            name: "gpt-5.6-luna",
            ref: "mock-openai/gpt-5.6-luna",
          },
          fixture: "mock-openai",
        },
        channel: {
          id: "qa-channel",
          live: false,
          driver: "local-shim",
        },
        packageSource: {
          kind: "source-checkout",
        },
        environment: {
          ref: "abc123",
          os: process.platform,
          nodeVersion: process.version,
        },
        artifacts: [
          {
            kind: "summary",
            path: "qa-suite-summary.json",
            source: "qa-suite",
          },
          {
            kind: "report",
            path: "qa-suite-report.md",
            source: "qa-suite",
          },
        ],
      },
      result: {
        status: "pass",
      },
    });
  });

  it("records complete structured RTT provenance and gives it canonical timing precedence", () => {
    const rttMeasurement = {
      finalMatchedReplyRttMs: 1750,
      requestStartedAt: "2026-09-03T00:00:00.000Z",
      responseObservedAt: "2026-09-03T00:00:01.750Z",
      source: "request-to-observed-message",
    };
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [],
      channelId: "slack",
      generatedAt: "2026-09-03T00:00:02.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioDefinitions: [{ id: "slack-canary", title: "Slack canary" }],
      scenarioResults: [
        {
          name: "Slack canary",
          status: "pass",
          timing: { rttMs: 999 },
          rttMeasurement,
        },
      ],
    });

    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.entries[0]?.result).toMatchObject({
      status: "pass",
      timing: { rttMs: 1750 },
      rttMeasurement,
    });
    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
  });

  it.each([
    ["timing only", { timing: { rttMs: 1750 } }],
    [
      "incomplete measurement",
      { rttMeasurement: { finalMatchedReplyRttMs: 1750, source: "summary-rtt" } },
    ],
  ])("does not fabricate structured RTT provenance from %s input", (_label, resultInput) => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [],
      channelId: "slack",
      generatedAt: "2026-09-03T00:00:02.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioDefinitions: [{ id: "slack-canary", title: "Slack canary" }],
      scenarioResults: [{ name: "Slack canary", status: "pass", ...resultInput }],
    });

    expect(evidence.entries[0]?.result.timing).toEqual({ rttMs: 1750 });
    expect(evidence.entries[0]?.result.rttMeasurement).toBeUndefined();
  });

  it("validates structured RTT measurements as strict schema-v2 objects", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [],
      channelId: "slack",
      generatedAt: "2026-09-03T00:00:02.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioDefinitions: [{ id: "slack-canary", title: "Slack canary" }],
      scenarioResults: [
        {
          name: "Slack canary",
          status: "pass",
          rttMeasurement: {
            finalMatchedReplyRttMs: 1750,
            requestStartedAt: "2026-09-03T00:00:00.000Z",
            responseObservedAt: "2026-09-03T00:00:01.750Z",
            source: "request-to-observed-message",
          },
        },
      ],
    });
    const invalidEvidence = structuredClone(evidence) as unknown as {
      entries: Array<{ result: { rttMeasurement?: Record<string, unknown> } }>;
    };
    const invalidEntry = expectDefined(invalidEvidence.entries[0], "QA evidence entry");
    const invalidMeasurement = expectDefined(invalidEntry.result.rttMeasurement, "RTT measurement");
    invalidMeasurement.extra = true;

    expect(() => validateQaEvidenceSummaryJson(invalidEvidence)).toThrow();
  });

  it.each([
    ["live Discord transport", "discord", "live", undefined, "live", true],
    ["live Matrix transport", "matrix", "live", undefined, "live", true],
    ["live Slack transport", "slack", "live", undefined, "live", true],
    ["live Telegram transport", "telegram", "live", undefined, "live", true],
    ["live WhatsApp transport", "whatsapp", "live", undefined, "live", true],
    [
      "live transport without a bundled channel identity",
      "custom-live-transport",
      "live",
      undefined,
      "live",
      true,
    ],
    [
      "synthetic driver for a real channel identity",
      "telegram",
      "qa-channel",
      undefined,
      "qa-channel",
      false,
    ],
    [
      "Crabline driver for a real channel identity",
      "telegram",
      "crabline",
      undefined,
      "crabline",
      false,
    ],
    [
      "explicit synthetic driver ignores requested environment metadata",
      "telegram",
      "qa-channel",
      { OPENCLAW_QA_CHANNEL_DRIVER: "live" },
      "qa-channel",
      false,
    ],
    [
      "transport without a resolved driver",
      "custom-live-transport",
      undefined,
      undefined,
      undefined,
      false,
    ],
  ] as const)(
    "records actual channel liveness for %s independently of model liveness",
    (_label, channelId, channelDriver, env, expectedDriver, expectedLive) => {
      const evidence = buildQaSuiteEvidenceSummary({
        artifactPaths: [],
        channelId,
        channelDriver,
        env,
        generatedAt: "2026-07-25T00:00:00.000Z",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        scenarioDefinitions: [{ id: "channel-liveness", title: "Channel liveness" }],
        scenarioResults: [{ name: "Channel liveness", status: "pass" }],
      });

      expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
      expect(evidence.entries[0]?.execution?.channel).toEqual({
        id: channelId,
        live: expectedLive,
        driver: expectedDriver,
      });
      expect(evidence.entries[0]?.execution?.provider.live).toBe(false);
    },
  );

  it("prefers the checked-out ref over an inherited GitHub event SHA", () => {
    const repoRoot = process.cwd();
    const checkedOutRef = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [],
      channelId: "qa-channel",
      env: {
        GITHUB_SHA: "bd479958c04a1eadbda8b6105e0722588d71e9ad",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-24T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot,
      scenarioDefinitions: [{ id: "ref-probe", title: "Ref probe" }],
      scenarioResults: [{ name: "Ref probe", status: "pass" }],
    });

    expect(evidence.entries[0]?.execution?.environment.ref).toBe(checkedOutRef);
  });

  it("builds Vitest runner evidence entries", () => {
    const evidence = buildVitestEvidenceSummary({
      artifactPaths: [
        { kind: "runner-result", path: "vitest-results/runtime-boundary.vitest.json" },
      ],
      env: {
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:06:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      targets: [
        {
          id: "runtime.agent-runner-boundary",
          title: "Agent runner boundary integration tests",
          sourcePath: "src/agents/agent-runner.e2e.test.ts",
          primaryCoverageIds: ["runtime.agent-runner", "runtime.delivery"],
          codeRefs: ["src/agents/agent-runner.ts"],
        },
      ],
      results: [
        {
          id: "runtime.agent-runner-boundary",
          status: "pass",
          durationMs: 1234,
        },
      ],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.profile).toBeUndefined();
    expect(evidence.entries).toEqual([
      expect.objectContaining({
        test: {
          kind: "vitest-test",
          id: "runtime.agent-runner-boundary",
          title: "Agent runner boundary integration tests",
          source: {
            path: "src/agents/agent-runner.e2e.test.ts",
          },
        },
        coverage: [
          {
            id: "runtime.agent-runner",
            role: "primary",
          },
          {
            id: "runtime.delivery",
            role: "primary",
          },
        ],
        refs: [
          {
            kind: "code",
            path: "src/agents/agent-runner.ts",
          },
        ],
        execution: expect.objectContaining({
          runner: "vitest",
          provider: expect.objectContaining({
            live: false,
            fixture: "mock-openai",
          }),
          artifacts: [
            {
              kind: "runner-result",
              path: "vitest-results/runtime-boundary.vitest.json",
              source: "vitest",
            },
          ],
        }),
        result: {
          status: "pass",
          timing: {
            wallMs: 1234,
          },
        },
      }),
    ]);
  });

  it("builds Playwright runner evidence entries", () => {
    const evidence = buildPlaywrightEvidenceSummary({
      artifactPaths: [
        { kind: "runner-result", path: "playwright-results/control-ui.json" },
        { kind: "report", path: "playwright-report/index.html" },
      ],
      env: {
        GITHUB_SHA: "def456",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:07:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      targets: [
        {
          id: "control-ui.browser-run",
          title: "Control UI browser workflow",
          sourcePath: "ui/control-ui.e2e.test.ts",
          primaryCoverageIds: ["ui.control"],
          docsRefs: ["docs/concepts/qa-e2e-automation.md"],
          codeRefs: ["ui/"],
        },
      ],
      results: [
        {
          id: "control-ui.browser-run",
          status: "fail",
          durationMs: 2300,
          failureMessage: "locator timed out",
        },
      ],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.profile).toBeUndefined();
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "control-ui.browser-run",
        title: "Control UI browser workflow",
        source: {
          path: "ui/control-ui.e2e.test.ts",
        },
      },
      coverage: [
        {
          id: "ui.control",
          role: "primary",
        },
      ],
      refs: [
        {
          kind: "docs",
          path: "docs/concepts/qa-e2e-automation.md",
        },
        {
          kind: "code",
          path: "ui/",
        },
      ],
      execution: {
        runner: "playwright",
        artifacts: [
          {
            kind: "runner-result",
            path: "playwright-results/control-ui.json",
            source: "playwright",
          },
          {
            kind: "report",
            path: "playwright-report/index.html",
            source: "playwright",
          },
        ],
      },
      result: {
        status: "fail",
        failure: {
          reason: "locator timed out",
        },
        timing: {
          wallMs: 2300,
        },
      },
    });
  });

  it("carries profile env values without hardcoding taxonomy coverage ids", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [{ kind: "summary", path: "qa-suite-summary.json" }],
      scenarioDefinitions: [
        {
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
          surface: "dm",
          coverage: {
            primary: ["channels.dm"],
          },
        },
      ],
      channelId: "qa-channel",
      env: {
        OPENCLAW_QA_PROFILE: "experimental-profile",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:09:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(evidence.profile).toBe("experimental-profile");
  });

  it.each([
    { evidenceMode: undefined, expectedMode: "slim", hasExecution: false },
    { evidenceMode: "full" as const, expectedMode: "full", hasExecution: true },
  ])(
    "resolves profile evidence mode $expectedMode",
    ({ evidenceMode, expectedMode, hasExecution }) => {
      const evidence = buildQaSuiteEvidenceSummary({
        artifactPaths: [{ kind: "summary", path: "qa-suite-summary.json" }],
        ...(evidenceMode ? { evidenceMode } : {}),
        profile: "smoke-ci",
        scenarioDefinitions: [
          {
            id: "dm-chat-baseline",
            title: "DM baseline conversation",
            coverage: {
              primary: ["channels.dm"],
            },
          },
        ],
        channelId: "qa-channel",
        generatedAt: "2026-06-07T12:09:00.000Z",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
      });

      expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
      expect(evidence.evidenceMode).toBe(expectedMode);
      expect("execution" in expectDefined(evidence.entries[0], "QA evidence entry")).toBe(
        hasExecution,
      );
    },
  );

  it("keeps mock non-OpenAI model refs attributed to their model provider", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: [{ kind: "summary", path: "qa-suite-summary.json" }],
      scenarioDefinitions: [
        {
          id: "anthropic-parity",
          title: "Anthropic parity",
          surface: "runtime",
          coverage: {
            primary: ["providers.anthropic"],
          },
        },
      ],
      channelId: "qa-channel",
      generatedAt: "2026-06-07T12:10:00.000Z",
      primaryModel: "anthropic/claude-opus-4-8",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "Anthropic parity", status: "pass" }],
    });

    expect(evidence.entries[0]?.execution).toMatchObject({
      provider: {
        id: "anthropic",
        model: {
          name: "claude-opus-4-8",
          ref: "anthropic/claude-opus-4-8",
        },
      },
    });
    expect(evidence.entries[0]).toMatchObject({
      execution: {
        provider: {
          live: false,
          fixture: "mock-openai",
        },
      },
    });
  });
});

const unknownIdentity: QaEvidenceIdentity = {
  source: { ref: null, integrity: null },
  runtime: { id: null, version: null },
  package: null,
  protocol: null,
  accountRef: null,
  proofClass: null,
};

function occurrenceFixture(instanceId = "scheduled-first") {
  const anchor: QaEvidenceOccurrence = {
    id: instanceId,
    parentCell: { scenarioId: "dm", executionKind: "script", channel: "qa-channel" },
    scenario: { kind: "instance", resultOccurrenceId: `${instanceId}/attempt-1` },
    retryOf: null,
    terminalStatus: null,
    assertions: null,
    launch: unknownIdentity,
    receipts: [],
  };
  const observation: QaEvidenceOccurrence = {
    ...anchor,
    id: `${instanceId}/attempt-1`,
    scenario: { kind: "observation", instanceOccurrenceId: instanceId },
    terminalStatus: "pass",
    assertions: [
      {
        id: "delivers-reply",
        meaning: "An inbound DM produces an outbound reply.",
        coverage: [{ id: "channels.dm", role: "primary" }],
      },
    ],
  };
  const entry: QaEvidenceSummaryV3Entry = {
    test: { kind: "script-test", id: "same-reporter-id", title: "DM reply" },
    coverage: [{ id: "channels.dm", role: "primary" }],
    result: { status: "pass" },
    binding: { occurrenceId: observation.id, assertionId: "delivers-reply", receiptId: null },
    effective: true,
  };
  return { anchor, observation, entry };
}

function occurrenceSummary(
  occurrences: QaEvidenceOccurrence[],
  entries: QaEvidenceSummaryV3Entry[],
  evidenceMode: "full" | "slim" = "full",
) {
  return buildQaOccurrenceEvidenceSummary({
    generatedAt: "2026-09-13T00:00:00.000Z",
    evidenceMode,
    occurrences,
    entries,
  });
}

describe("occurrence evidence", () => {
  it("retains v2 row order, duplicate IDs and strict serialized shape", () => {
    const legacy = {
      kind: QA_EVIDENCE_SUMMARY_KIND,
      schemaVersion: 2,
      generatedAt: "2026-09-13T00:00:00.000Z",
      evidenceMode: "full",
      entries: [
        {
          test: { kind: "script-test", id: "same", title: "first" },
          coverage: [],
          result: { status: "fail" },
        },
        {
          test: { kind: "script-test", id: "same", title: "second" },
          coverage: [],
          result: { status: "pass" },
        },
      ],
    };
    const parsed = validateQaEvidenceSummaryJson(legacy);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
    expect(getEffectiveQaEvidenceEntries(parsed)).toBe(parsed.entries);
    expect(projectQaEvidenceScenarioOutcomes(parsed).map((outcome) => outcome.status)).toEqual([
      "fail",
      "pass",
    ]);
    expect(() => validateQaEvidenceSummaryJson({ ...legacy, occurrences: [] })).toThrow();
    expect(() => validateQaEvidenceSummaryJson({ ...legacy, schemaVersion: 4 })).toThrow();
    expect(
      mergeQaEvidenceSummaries({ evidenceSummaries: [], generatedAt: legacy.generatedAt }),
    ).toEqual({
      ...legacy,
      entries: [],
    });
  });

  it("preserves an unresolved first instance and independent duplicate scenario and reporter IDs", () => {
    const first = occurrenceFixture();
    first.anchor.scenario = { kind: "instance", resultOccurrenceId: null };
    const second = occurrenceFixture("scheduled-second");
    const summary = occurrenceSummary(
      [first.anchor, second.anchor, second.observation],
      [second.entry, { ...second.entry, coverage: [] }],
    );
    expect(projectQaEvidenceScenarioOutcomes(summary)).toEqual([
      { scenarioId: "dm", scenarioInstanceId: first.anchor.id, occurrenceId: null, status: null },
      {
        scenarioId: "dm",
        scenarioInstanceId: second.anchor.id,
        occurrenceId: second.observation.id,
        status: "pass",
      },
    ]);
    expect(getEffectiveQaEvidenceEntries(summary)).toEqual(summary.entries);
  });

  it.each(["missing rows", "missing terminal"] as const)(
    "keeps the selected pointer with unknown status for %s",
    (missing) => {
      const { anchor, observation, entry } = occurrenceFixture();
      if (missing === "missing terminal") {
        observation.terminalStatus = null;
      }
      const summary = occurrenceSummary(
        [anchor, observation],
        missing === "missing rows" ? [] : [entry],
      );
      expect(projectQaEvidenceScenarioOutcomes(summary)[0]).toMatchObject({
        occurrenceId: observation.id,
        status: null,
      });
    },
  );

  it("uses the parent-selected failure instead of an independently passing child", () => {
    const { anchor, observation, entry } = occurrenceFixture();
    const parent: QaEvidenceOccurrence = {
      ...observation,
      id: "parent-roundtrip",
      terminalStatus: "fail",
      assertions: null,
    };
    anchor.scenario = { kind: "instance", resultOccurrenceId: parent.id };
    const summary = occurrenceSummary(
      [anchor, observation, parent],
      [
        entry,
        {
          ...entry,
          coverage: [],
          binding: { occurrenceId: parent.id, assertionId: null, receiptId: null },
          result: { status: "fail", failure: { reason: "roundtrip probe failed" } },
        },
      ],
    );
    expect(projectQaEvidenceScenarioOutcomes(summary)[0]?.status).toBe("fail");
  });

  it.each(["fail", "blocked", "skipped", "pass"] as const)(
    "applies whole-attempt selection when a retry is %s",
    (status) => {
      const { anchor, observation, entry } = occurrenceFixture();
      observation.terminalStatus = "fail";
      const retry: QaEvidenceOccurrence = {
        ...observation,
        id: "retry-2",
        retryOf: observation.id,
        terminalStatus: status,
      };
      anchor.scenario = {
        kind: "instance",
        resultOccurrenceId: status === "pass" ? retry.id : observation.id,
      };
      const initial = {
        ...entry,
        result: { status: "fail" as const },
        effective: status !== "pass",
      };
      const retried = {
        ...entry,
        binding: { ...entry.binding, occurrenceId: retry.id },
        result: { status },
        effective: status === "pass",
      };
      const summary = occurrenceSummary([anchor, observation, retry], [initial, retried]);
      expect(getEffectiveQaEvidenceEntries(summary)).toEqual([
        status === "pass" ? retried : initial,
      ]);
      expect(summary.entries).toHaveLength(2);
      expect(projectQaEvidenceScenarioOutcomes(summary)[0]?.status).toBe(
        status === "pass" ? "pass" : "fail",
      );
    },
  );

  it("preserves explicit launch and target identities, digests and bindings in slim output", () => {
    const { anchor, observation, entry } = occurrenceFixture();
    observation.launch = {
      ...unknownIdentity,
      source: { ref: "source-A", integrity: "source-digest-A" },
      runtime: { id: "node", version: "26.1.0" },
      package: {
        kind: "packed-tarball",
        spec: "candidate.tgz",
        version: null,
        integrity: "sha512-candidate",
      },
      protocol: "local-http",
      accountRef: "synthetic-account",
      proofClass: "fixture-only",
    };
    observation.receipts = [
      {
        id: "installed-target",
        phase: "installed",
        identity: {
          ...unknownIdentity,
          source: { ref: "source-B", integrity: "source-digest-B" },
          package: {
            kind: "npm-package",
            spec: "openclaw",
            version: "2026.9.1",
            integrity: "sha512-installed",
          },
          protocol: "gateway-v3",
          accountRef: "synthetic-target",
          proofClass: "packaged-install/upgrade",
        },
        artifact: {
          kind: "package-identity",
          path: "attempt-1/identity.json",
          source: "target",
          sha256: "a".repeat(64),
        },
      },
    ];
    entry.binding.receiptId = "installed-target";
    const full = occurrenceSummary([anchor, observation], [entry]);
    const slim = occurrenceSummary(full.occurrences, full.entries, "slim");
    expect(slim.occurrences).toEqual(full.occurrences);
    expect(slim.entries[0]?.binding).toEqual(entry.binding);
    expect(slim.occurrences[1]?.launch).not.toEqual(slim.occurrences[1]?.receipts[0]?.identity);
    expect(slim.entries[0]).not.toHaveProperty("execution");
    expect(() =>
      validateQaEvidenceSummaryJson({
        ...slim,
        occurrences: [
          anchor,
          { ...observation, launch: { ...observation.launch, proofClass: "passed" } },
        ],
      }),
    ).toThrow();
  });

  it("keeps ownerless diagnostics separate from scheduled outcomes", () => {
    const { observation, entry } = occurrenceFixture();
    observation.parentCell = null;
    observation.scenario = null;
    observation.assertions = null;
    entry.binding.assertionId = null;
    entry.coverage = [];
    const summary = occurrenceSummary([observation], [entry]);
    expect(getEffectiveQaEvidenceEntries(summary)).toHaveLength(1);
    expect(projectQaEvidenceScenarioOutcomes(summary)).toEqual([]);
  });

  it.each([
    "missing occurrence",
    "anchor row",
    "missing assertion",
    "extra coverage",
    "unknown receipt",
    "mixed effectiveness",
    "wrong instance",
    "duplicate occurrence",
    "stale selection",
    "retry cycle",
  ])("rejects corrupt ownership: %s", (failure) => {
    const { anchor, observation, entry } = occurrenceFixture();
    const occurrences = [anchor, observation];
    const entries = [entry];
    switch (failure) {
      case "missing occurrence":
        entry.binding.occurrenceId = "absent";
        break;
      case "anchor row":
        entry.binding.occurrenceId = anchor.id;
        break;
      case "missing assertion":
        entry.binding.assertionId = "undeclared";
        break;
      case "extra coverage":
        entry.coverage = [{ id: "channels.rooms", role: "primary" }];
        break;
      case "unknown receipt":
        entry.binding.receiptId = "another-target";
        break;
      case "mixed effectiveness":
        entries.push({ ...entry, effective: false });
        break;
      case "wrong instance":
        observation.parentCell = { ...observation.parentCell!, scenarioId: "other" };
        break;
      case "duplicate occurrence":
        occurrences.push(observation);
        break;
      case "stale selection":
        anchor.scenario = { kind: "instance", resultOccurrenceId: "absent" };
        break;
      case "retry cycle":
        observation.retryOf = observation.id;
        break;
    }
    expect(() => occurrenceSummary(occurrences, entries)).toThrow();
  });

  it("merges v3 in scheduling order without inventing v2 custody or accepting conflicting anchors", () => {
    const first = occurrenceFixture();
    const second = occurrenceFixture("second");
    const a = occurrenceSummary([first.anchor, first.observation], [first.entry]);
    const b = occurrenceSummary([second.anchor, second.observation], [second.entry]);
    const merged = mergeQaEvidenceSummaries({
      evidenceSummaries: [a, b],
      generatedAt: a.generatedAt,
    });
    expect(
      projectQaEvidenceScenarioOutcomes(merged).map((outcome) => outcome.scenarioInstanceId),
    ).toEqual([first.anchor.id, second.anchor.id]);
    expect(merged.entries.map((entry) => entry.test.id)).toEqual([
      "same-reporter-id",
      "same-reporter-id",
    ]);
    const unresolved = occurrenceSummary(
      [{ ...first.anchor, scenario: { kind: "instance", resultOccurrenceId: null } }],
      [],
    );
    expect(() =>
      mergeQaEvidenceSummaries({ evidenceSummaries: [a, unresolved], generatedAt: a.generatedAt }),
    ).toThrow(/conflicting/);
    const legacy = mergeQaEvidenceSummaries({ evidenceSummaries: [], generatedAt: a.generatedAt });
    expect(() =>
      mergeQaEvidenceSummaries({ evidenceSummaries: [legacy, a], generatedAt: a.generatedAt }),
    ).toThrow(/invocation-owned import/);
  });
});
