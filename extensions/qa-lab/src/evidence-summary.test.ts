// Qa Lab tests cover normalized evidence summary behavior.
import { describe, expect, it } from "vitest";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  buildLiveTransportEvidenceSummary,
  buildQaSuiteEvidenceSummary,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";

describe("evidence summary", () => {
  it("builds scorecard-ready QA suite evidence entries from catalog metadata", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: ["qa-suite-summary.json", "qa-suite-report.md"],
      catalogScenarios: [
        {
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
          surface: "dm",
          coverage: {
            primary: ["channels.dm"],
            secondary: ["channels.qa-channel"],
          },
          docsRefs: ["docs/channels/qa-channel.md"],
          codeRefs: ["extensions/qa-channel/src/gateway.ts"],
        },
      ],
      channelId: "qa-channel",
      env: {
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.5",
      providerMode: "mock-openai",
      scenarios: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      scenarioId: "dm-chat-baseline",
      coverageIds: ["channels.dm", "channels.qa-channel"],
      sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
      scorecard: {
        surfaceIds: ["dm"],
        categoryIds: ["channels.dm"],
      },
      tier: "core",
      provider: {
        id: "openai",
        live: false,
        modelName: "gpt-5.5",
        modelRef: "mock-openai/gpt-5.5",
        fixture: "mock-openai",
      },
      channel: {
        id: "qa-channel",
        live: false,
      },
      packageSource: {
        kind: "source-checkout",
      },
      environment: {
        ref: "abc123",
        os: process.platform,
        nodeVersion: process.version,
      },
      artifactPaths: ["qa-suite-summary.json", "qa-suite-report.md"],
      status: "pass",
    });
  });

  it("normalizes Telegram live summaries onto the same evidence schema", () => {
    const evidence = buildLiveTransportEvidenceSummary({
      artifactPaths: [
        "telegram-qa-summary.json",
        "telegram-qa-report.md",
        "telegram-qa-observed-messages.json",
      ],
      env: {
        OPENCLAW_QA_RUNNER: "crabbox",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:05:00.000Z",
      primaryModel: "openai/gpt-5.5",
      providerMode: "live-frontier",
      scenarioDefinitions: [
        {
          id: "telegram-canary",
          standardId: "canary",
          title: "Telegram canary",
        },
      ],
      scenarios: [
        {
          id: "telegram-canary",
          title: "Telegram canary",
          status: "fail",
          details: "timed out waiting for SUT reply",
          rttMs: 4321,
        },
      ],
      transportId: "telegram",
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.entries).toEqual([
      expect.objectContaining({
        scenarioId: "telegram-canary",
        coverageIds: ["channels.telegram.canary", "channels.telegram.live"],
        scorecard: {
          surfaceIds: ["channels.telegram"],
          categoryIds: ["channels.telegram.live"],
        },
        tier: "release",
        provider: {
          id: "openai",
          live: true,
          modelName: "gpt-5.5",
          modelRef: "openai/gpt-5.5",
          profile: "live-frontier",
        },
        channel: {
          id: "telegram",
          live: true,
        },
        runner: "crabbox",
        artifactPaths: [
          "telegram-qa-summary.json",
          "telegram-qa-report.md",
          "telegram-qa-observed-messages.json",
        ],
        status: "fail",
        failure: {
          reason: "timed out waiting for SUT reply",
        },
        timing: {
          rttMs: 4321,
        },
      }),
    ]);
  });

  it("keeps mock non-OpenAI model refs attributed to their model provider", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: ["qa-suite-summary.json"],
      catalogScenarios: [
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
      scenarios: [{ name: "Anthropic parity", status: "pass" }],
    });

    expect(evidence.entries[0]?.provider).toMatchObject({
      id: "anthropic",
      live: false,
      fixture: "mock-openai",
      modelName: "claude-opus-4-8",
      modelRef: "anthropic/claude-opus-4-8",
    });
  });

  it("derives package provenance from package runner env", () => {
    const npmEvidence = buildLiveTransportEvidenceSummary({
      artifactPaths: ["telegram-qa-summary.json"],
      env: {
        OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE: "openclaw@beta",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:15:00.000Z",
      primaryModel: "openai/gpt-5.5",
      providerMode: "live-frontier",
      scenarioDefinitions: [
        {
          id: "telegram-canary",
          standardId: "canary",
          title: "Telegram canary",
        },
      ],
      scenarios: [{ id: "telegram-canary", status: "pass" }],
      transportId: "telegram",
    });
    const tarballEvidence = buildLiveTransportEvidenceSummary({
      artifactPaths: ["telegram-qa-summary.json"],
      env: {
        OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE: "/tmp/openclaw.tgz",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:16:00.000Z",
      primaryModel: "openai/gpt-5.5",
      providerMode: "live-frontier",
      scenarioDefinitions: [
        {
          id: "telegram-canary",
          standardId: "canary",
          title: "Telegram canary",
        },
      ],
      scenarios: [{ id: "telegram-canary", status: "pass" }],
      transportId: "telegram",
    });

    expect(npmEvidence.entries[0]?.packageSource).toEqual({
      kind: "npm-package",
      spec: "openclaw@beta",
    });
    expect(tarballEvidence.entries[0]?.packageSource).toEqual({
      kind: "packed-tarball",
      spec: "/tmp/openclaw.tgz",
    });
  });
});
