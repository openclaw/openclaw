// Qa Lab tests cover normalized evidence summary behavior.
import { describe, expect, it } from "vitest";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  buildLiveTransportEvidenceSummary,
  buildPlaywrightEvidenceSummary,
  buildQaSuiteEvidenceSummary,
  buildVitestEvidenceSummary,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";

describe("evidence summary", () => {
  it("builds scorecard-ready QA suite evidence entries from catalog metadata", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: ["qa-suite-summary.json", "qa-suite-report.md"],
      scenarioSpecs: [
        {
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
          surface: "dm",
          coverage: {
            primary: ["channels.dm"],
            secondary: ["channels.qa-channel"],
          },
          runtimeParityTier: "standard",
          docsRefs: ["docs/channels/qa-channel.md"],
          codeRefs: ["extensions/qa-channel/src/gateway.ts"],
        },
      ],
      channelId: "qa-channel",
      env: {
        OPENCLAW_QA_CHANNEL_DRIVER: "local-shim",
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.5",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
    expect(evidence.schemaVersion).toBe(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "qa-scenario",
        id: "dm-chat-baseline",
        title: "DM baseline conversation",
        sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
      },
      coverageIds: ["channels.dm", "channels.qa-channel"],
      runtimeParity: "standard",
      scorecard: {
        surfaceIds: ["dm"],
        categoryIds: ["channels.dm"],
      },
      profile: "smoke-ci",
      provider: {
        id: "openai",
        modelName: "gpt-5.5",
        modelRef: "mock-openai/gpt-5.5",
      },
      model_live: false,
      provider_fixture: "mock-openai",
      channel: {
        id: "qa-channel",
      },
      channel_live: false,
      channel_driver: "local-shim",
      runner: "host",
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
      scenarioResults: [
        {
          id: "telegram-canary",
          standardId: "canary",
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
        test: {
          kind: "live-transport-check",
          id: "telegram-canary",
          title: "Telegram canary",
        },
        coverageIds: ["channels.telegram.canary", "channels.telegram.live"],
        scorecard: {
          surfaceIds: ["channels.telegram"],
          categoryIds: ["channels.telegram.live"],
        },
        profile: "release",
        provider: {
          id: "openai",
          modelName: "gpt-5.5",
          modelRef: "openai/gpt-5.5",
        },
        model_live: true,
        provider_auth: "live-frontier",
        channel: {
          id: "telegram",
        },
        channel_live: true,
        channel_driver: "native",
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

  it("normalizes Vitest runner results onto the same evidence schema", () => {
    const evidence = buildVitestEvidenceSummary({
      artifactPaths: ["vitest-results/runtime-boundary.vitest.json"],
      env: {
        OPENCLAW_QA_REF: "abc123",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:06:00.000Z",
      primaryModel: "mock-openai/gpt-5.5",
      providerMode: "mock-openai",
      targets: [
        {
          id: "runtime.agent-runner-boundary",
          title: "Agent runner boundary integration tests",
          sourcePath: "src/agents/agent-runner.e2e.test.ts",
          coverageIds: ["runtime.agent-runner", "runtime.delivery"],
          surfaceIds: ["agent-runtime-and-provider-execution"],
          categoryIds: ["agent-runtime-and-provider-execution.agent-turn-execution"],
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
    expect(evidence.entries).toEqual([
      expect.objectContaining({
        test: {
          kind: "vitest-test",
          id: "runtime.agent-runner-boundary",
          title: "Agent runner boundary integration tests",
          sourcePath: "src/agents/agent-runner.e2e.test.ts",
        },
        coverageIds: ["runtime.agent-runner", "runtime.delivery"],
        scorecard: {
          surfaceIds: ["agent-runtime-and-provider-execution"],
          categoryIds: ["agent-runtime-and-provider-execution.agent-turn-execution"],
        },
        profile: "smoke-ci",
        model_live: false,
        provider_fixture: "mock-openai",
        runner: "vitest",
        artifactPaths: ["vitest-results/runtime-boundary.vitest.json"],
        status: "pass",
        timing: {
          wallMs: 1234,
        },
      }),
    ]);
  });

  it("normalizes Playwright runner results onto the same evidence schema", () => {
    const evidence = buildPlaywrightEvidenceSummary({
      artifactPaths: ["playwright-results/control-ui.json", "playwright-report/index.html"],
      env: {
        GITHUB_SHA: "def456",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-07T12:07:00.000Z",
      primaryModel: "mock-openai/gpt-5.5",
      providerMode: "mock-openai",
      targets: [
        {
          id: "control-ui.browser-run",
          title: "Control UI browser workflow",
          sourcePath: "ui/control-ui.e2e.test.ts",
          coverageIds: ["control-ui.browser"],
          surfaceIds: ["browser-control-ui-and-webchat"],
          categoryIds: ["browser-control-ui-and-webchat.browser-ui"],
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
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "control-ui.browser-run",
        title: "Control UI browser workflow",
        sourcePath: "ui/control-ui.e2e.test.ts",
      },
      coverageIds: ["control-ui.browser"],
      scorecard: {
        surfaceIds: ["browser-control-ui-and-webchat"],
        categoryIds: ["browser-control-ui-and-webchat.browser-ui"],
      },
      runner: "playwright",
      artifactPaths: ["playwright-results/control-ui.json", "playwright-report/index.html"],
      status: "fail",
      failure: {
        reason: "locator timed out",
      },
      timing: {
        wallMs: 2300,
      },
    });
  });

  it("carries profile env values without hardcoding taxonomy mapping ids", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: ["qa-suite-summary.json"],
      scenarioSpecs: [
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
      primaryModel: "mock-openai/gpt-5.5",
      providerMode: "mock-openai",
      scenarioResults: [{ name: "DM baseline conversation", status: "pass" }],
    });

    expect(evidence.entries[0]?.profile).toBe("experimental-profile");
  });

  it("keeps mock non-OpenAI model refs attributed to their model provider", () => {
    const evidence = buildQaSuiteEvidenceSummary({
      artifactPaths: ["qa-suite-summary.json"],
      scenarioSpecs: [
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

    expect(evidence.entries[0]?.provider).toMatchObject({
      id: "anthropic",
      modelName: "claude-opus-4-8",
      modelRef: "anthropic/claude-opus-4-8",
    });
    expect(evidence.entries[0]).toMatchObject({
      model_live: false,
      provider_fixture: "mock-openai",
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
      scenarioResults: [{ id: "telegram-canary", standardId: "canary", status: "pass" }],
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
      scenarioResults: [{ id: "telegram-canary", standardId: "canary", status: "pass" }],
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
