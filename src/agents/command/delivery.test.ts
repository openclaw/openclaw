import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackOutbound } from "../../../test/channel-outbounds.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverAgentCommandResult, normalizeAgentCommandReplyPayloads } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

type NormalizeParams = Parameters<typeof normalizeAgentCommandReplyPayloads>[0];
type RunResult = NormalizeParams["result"];

const emptyRegistry = createTestRegistry([]);
const slackRegistry = createTestRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "slack",
      outbound: slackOutbound,
      messaging: {
        enableInteractiveReplies: ({ cfg }) =>
          (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
            ?.capabilities?.interactiveReplies === true,
      },
    }),
  },
]);

function createResult(overrides: Partial<RunResult> & Record<string, unknown> = {}): RunResult {
  return {
    ...overrides,
    meta: {
      durationMs: 1,
      ...overrides.meta,
    },
  } as RunResult;
}

describe("normalizeAgentCommandReplyPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(slackRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("compiles Slack directives for direct agent deliveries when interactive replies are enabled", () => {
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
        text: "Choose",
        interactive: {
          blocks: [
            {
              type: "text",
              text: "Choose",
            },
            {
              type: "buttons",
              buttons: [{ label: "Retry", value: "retry" }],
            },
          ],
        },
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
    expect(String(runtime.log.mock.calls[0]?.[0] ?? "")).toContain("Options: on, off.");
    expect(String(runtime.log.mock.calls[0]?.[0] ?? "")).toContain("`[COMPLETE]:");
    expect(delivered.payloads).toMatchObject([
      {
        text: expect.stringContaining("Options: on, off."),
      },
    ]);
    expect(delivered.payloads[0]?.text ?? "").toContain("`[COMPLETE]:");
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
    expect(String(runtime.log.mock.calls[0]?.[0] ?? "")).toContain(
      "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
    );
    expect(String(runtime.log.mock.calls[0]?.[0] ?? "")).toContain("`[COMPLETE]:");
    expect(delivered.payloads).toMatchObject([
      {
        text: expect.stringContaining(
          "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
        ),
      },
    ]);
    expect(delivered.payloads[0]?.text ?? "").toContain("`[COMPLETE]:");
  });

  it("appends a terminal status tag to final replies", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "slack",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready." }],
      result: createResult({
        meta: {
          durationMs: 65_000,
        },
      }),
    });

    expect(delivered.payloads[0]?.text ?? "").toContain("Ready.");
    expect(delivered.payloads[0]?.text ?? "").toContain(
      "`[COMPLETE]: đã hoàn tất sau 65 giây xử lý`",
    );
  });

  it("synthesizes a user-safe tagged fallback when a run ends without payloads", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "slack",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [],
      result: createResult({
        meta: {
          durationMs: 120_000,
          stopReason: "stop",
        },
      }),
    });

    expect(delivered.deliveryConfirmed).toBe(true);
    expect(delivered.payloads[0]?.text ?? "").toContain("chưa tạo được cập nhật cuối cùng sẵn sàng để gửi");
    expect(delivered.payloads[0]?.text ?? "").not.toContain("did not produce a final reply");
    expect(delivered.payloads[0]?.text ?? "").not.toContain("no final reply was produced");
    expect(delivered.payloads[0]?.text ?? "").toContain("`[STOP]:");
  });

  it("emits WORKING status with Vietnamese diacritics for tool-call continuations", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "slack",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Đang xử lý." }],
      result: createResult({
        meta: {
          durationMs: 61_000,
          stopReason: "tool_calls",
        },
      }),
    });

    expect(delivered.payloads[0]?.text ?? "").toContain(
      "`[WORKING]: đang xử lý, dự kiến cần hơn 60 giây vì model/tool vẫn đang chạy`",
    );
    expect(delivered.payloads[0]?.text ?? "").not.toContain("dang xu ly");
  });

  it("treats empty payloads as delivered when a messaging tool already sent the reply", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "telegram",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [],
      result: createResult({
        didSendViaMessagingTool: true,
      }),
    });

    expect(delivered.deliveryConfirmed).toBe(true);
    expect(delivered.payloads).toEqual([]);
    expect(runtime.log).toHaveBeenCalledWith("Reply already delivered by messaging tool.");
  });
});
