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
  it("builds taxonomy-mapped QA suite evidence entries from catalog metadata", () => {
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
        source: {
          path: "qa/scenarios/channels/dm-chat-baseline.md",
        },
      },
      mapping: {
        profile: {
          id: "smoke-ci",
        },
        coverage: [
          {
            id: "channels.dm",
            role: "primary",
            sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
            surfaceIds: ["dm"],
            categoryIds: ["channels.dm"],
            refIds: [
              "code:extensions/qa-channel/src/gateway.ts",
              "docs:docs/channels/qa-channel.md",
            ],
          },
          {
            id: "channels.qa-channel",
            role: "secondary",
            sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
            surfaceIds: ["dm"],
            categoryIds: [],
            refIds: [
              "code:extensions/qa-channel/src/gateway.ts",
              "docs:docs/channels/qa-channel.md",
            ],
          },
        ],
        refs: [
          {
            id: "docs:docs/channels/qa-channel.md",
            kind: "docs",
            path: "docs/channels/qa-channel.md",
            sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
          },
          {
            id: "code:extensions/qa-channel/src/gateway.ts",
            kind: "code",
            path: "extensions/qa-channel/src/gateway.ts",
            sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
          },
        ],
        runtimeParity: {
          id: "standard",
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.md",
        },
      },
      execution: {
        runner: {
          id: "host",
        },
        provider: {
          id: "openai",
          live: false,
          model: {
            name: "gpt-5.5",
            ref: "mock-openai/gpt-5.5",
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
        mapping: {
          profile: {
            id: "release",
          },
          coverage: [
            {
              id: "channels.telegram.live",
              role: "live-transport",
              surfaceIds: ["channels.telegram"],
              categoryIds: ["channels.telegram.live"],
            },
            {
              id: "channels.telegram.canary",
              role: "live-transport-standard",
              surfaceIds: ["channels.telegram"],
              categoryIds: ["channels.telegram.live"],
            },
          ],
        },
        execution: expect.objectContaining({
          runner: {
            id: "crabbox",
          },
          provider: {
            id: "openai",
            live: true,
            model: {
              name: "gpt-5.5",
              ref: "openai/gpt-5.5",
            },
            auth: "live-frontier",
          },
          channel: {
            id: "telegram",
            live: true,
            driver: "native",
          },
          artifacts: [
            {
              kind: "summary",
              path: "telegram-qa-summary.json",
              source: "telegram-live-transport",
            },
            {
              kind: "report",
              path: "telegram-qa-report.md",
              source: "telegram-live-transport",
            },
            {
              kind: "transport-observations",
              path: "telegram-qa-observed-messages.json",
              source: "telegram-live-transport",
            },
          ],
        }),
        result: {
          status: "fail",
          failure: {
            reason: "timed out waiting for SUT reply",
          },
          timing: {
            rttMs: 4321,
          },
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
          source: {
            path: "src/agents/agent-runner.e2e.test.ts",
          },
        },
        mapping: {
          profile: {
            id: "smoke-ci",
          },
          coverage: [
            {
              id: "runtime.agent-runner",
              role: "primary",
              sourcePath: "src/agents/agent-runner.e2e.test.ts",
              surfaceIds: ["agent-runtime-and-provider-execution"],
              categoryIds: ["agent-runtime-and-provider-execution.agent-turn-execution"],
              refIds: ["code:src/agents/agent-runner.ts"],
            },
            {
              id: "runtime.delivery",
              role: "primary",
              sourcePath: "src/agents/agent-runner.e2e.test.ts",
              surfaceIds: ["agent-runtime-and-provider-execution"],
              categoryIds: ["agent-runtime-and-provider-execution.agent-turn-execution"],
              refIds: ["code:src/agents/agent-runner.ts"],
            },
          ],
          refs: [
            {
              id: "code:src/agents/agent-runner.ts",
              kind: "code",
              path: "src/agents/agent-runner.ts",
              sourcePath: "src/agents/agent-runner.e2e.test.ts",
            },
          ],
        },
        execution: expect.objectContaining({
          runner: {
            id: "vitest",
          },
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
        source: {
          path: "ui/control-ui.e2e.test.ts",
        },
      },
      mapping: {
        coverage: [
          {
            id: "control-ui.browser",
            role: "primary",
            sourcePath: "ui/control-ui.e2e.test.ts",
            surfaceIds: ["browser-control-ui-and-webchat"],
            categoryIds: ["browser-control-ui-and-webchat.browser-ui"],
            refIds: ["code:ui/", "docs:docs/concepts/qa-e2e-automation.md"],
          },
        ],
        refs: [
          {
            id: "docs:docs/concepts/qa-e2e-automation.md",
            kind: "docs",
            path: "docs/concepts/qa-e2e-automation.md",
            sourcePath: "ui/control-ui.e2e.test.ts",
          },
          {
            id: "code:ui/",
            kind: "code",
            path: "ui/",
            sourcePath: "ui/control-ui.e2e.test.ts",
          },
        ],
      },
      execution: {
        runner: {
          id: "playwright",
        },
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

    expect(evidence.entries[0]?.mapping.profile.id).toBe("experimental-profile");
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

    expect(evidence.entries[0]?.execution.provider).toMatchObject({
      id: "anthropic",
      model: {
        name: "claude-opus-4-8",
        ref: "anthropic/claude-opus-4-8",
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

    expect(npmEvidence.entries[0]?.execution.packageSource).toEqual({
      kind: "npm-package",
      spec: "openclaw@beta",
    });
    expect(tarballEvidence.entries[0]?.execution.packageSource).toEqual({
      kind: "packed-tarball",
      spec: "/tmp/openclaw.tgz",
    });
  });
});
