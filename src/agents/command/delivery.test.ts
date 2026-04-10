import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverAgentCommandResult, normalizeAgentCommandReplyPayloads } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

const { announceLogInfoSpy, announceLogDebugSpy } = vi.hoisted(() => ({
  announceLogInfoSpy: vi.fn(),
  announceLogDebugSpy: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: (subsystem: string) => {
    if (subsystem === "agents/announce") {
      return {
        subsystem,
        isEnabled: () => true,
        trace: vi.fn(),
        debug: announceLogDebugSpy,
        info: announceLogInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        raw: vi.fn(),
        child: () => ({
          subsystem: `${subsystem}/child`,
          isEnabled: () => true,
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          raw: vi.fn(),
          child: vi.fn(),
        }),
      };
    }
    return {
      subsystem,
      isEnabled: () => false,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: vi.fn(),
    };
  },
}));

type NormalizeParams = Parameters<typeof normalizeAgentCommandReplyPayloads>[0];
type RunResult = NormalizeParams["result"];

const slackOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text }) => ({
    channel: "slack",
    messageId: `${to}:${text}`,
  }),
};

const emptyRegistry = createTestRegistry([]);
const slackRegistry = createTestRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "slack",
      outbound: slackOutboundForTest,
      messaging: {
        enableInteractiveReplies: ({ cfg }) =>
          (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
            ?.capabilities?.interactiveReplies === true,
      },
    }),
  },
]);

function createResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    meta: {
      durationMs: 1,
      ...overrides.meta,
    },
    ...(overrides.payloads ? { payloads: overrides.payloads } : {}),
  } as RunResult;
}

describe("normalizeAgentCommandReplyPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(slackRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("keeps Slack directives in text for direct agent deliveries", () => {
    const normalized = normalizeAgentCommandReplyPayloads({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      opts: { message: "test" } as AgentCommandOpts,
      outboundSession: undefined,
      deliveryChannel: "slack",
      payloads: [{ text: "Choose [[slack_buttons: Retry:retry]]" }],
      result: createResult(),
    });

    expect(normalized).toMatchObject([
      {
        text: "Choose [[slack_buttons: Retry:retry]]",
      },
    ]);
  });

  it("renders response prefix templates with the selected runtime model", () => {
    const normalized = normalizeAgentCommandReplyPayloads({
      cfg: {
        messages: {
          responsePrefix: "[{modelFull}]",
        },
      } as OpenClawConfig,
      opts: { message: "test" } as AgentCommandOpts,
      outboundSession: undefined,
      deliveryChannel: "slack",
      payloads: [{ text: "Ready." }],
      result: createResult({
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "session-1",
            provider: "openai-codex",
            model: "gpt-5.4",
          },
        },
      }),
    });

    expect(normalized).toMatchObject([
      {
        text: "[openai-codex/gpt-5.4] Ready.",
      },
    ]);
  });

  it("keeps Slack options text intact for local preview when delivery is disabled", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "slack",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Options: on, off." }],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith("Options: on, off.");
    expect(delivered.payloads).toMatchObject([{ text: "Options: on, off." }]);
  });

  it("routes announce run output through subsystem logger instead of runtime.log", async () => {
    announceLogInfoSpy.mockClear();
    announceLogDebugSpy.mockClear();
    const runtime = {
      log: vi.fn(),
    };

    const longBody =
      "Done.\n\nWhat changed\n- Found the false-success gap\n- Added a delivery contract\n" +
      "Commit\n- edaf79fd3348f52e731931e8958f36821f01691c";

    await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "announce trigger",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:worker",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: longBody }],
      result: createResult(),
    });

    // runtime.log must NOT be called at all — announce output routes through announceLog
    expect(runtime.log).not.toHaveBeenCalled();
    // subsystem logger info should get metadata-only line
    expect(announceLogInfoSpy).toHaveBeenCalledTimes(1);
    expect(announceLogInfoSpy).toHaveBeenCalledWith(expect.stringContaining("delivery:"));
    expect(announceLogInfoSpy).toHaveBeenCalledWith(expect.stringContaining("chars="));
    // subsystem logger debug should get full body
    expect(announceLogDebugSpy).toHaveBeenCalledTimes(1);
    expect(announceLogDebugSpy).toHaveBeenCalledWith(longBody);
  });

  it("keeps LINE directive-only replies intact for local preview when delivery is disabled", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "line",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [
        {
          text: "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
        },
      ],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
    );
    expect(delivered.payloads).toMatchObject([
      {
        text: "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
      },
    ]);
  });
});
