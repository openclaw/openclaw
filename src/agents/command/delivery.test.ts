import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  getChannelPlugin: vi.fn(() => ({})),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/agent-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/agent-delivery.js")>();
  return {
    ...actual,
    resolveAgentOutboundTarget: (params: Parameters<typeof actual.resolveAgentOutboundTarget>[0]) =>
      actual.resolveAgentOutboundTarget({
        ...params,
        // When the plan already has `resolvedTo`, skip `resolveOutboundTarget` (Vitest cannot
        // reliably mock that import inside this module).
        validateExplicitTarget: params.plan.resolvedTo?.trim()
          ? false
          : params.validateExplicitTarget,
      }),
  };
});

import type { ReplyPayload } from "../../auto-reply/types.js";
import type { CliDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as agentDelivery from "../../infra/outbound/agent-delivery.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";

describe("deliverAgentCommandResult", () => {
  it("agent-delivery mock forces plan-based resolution (no resolvedTarget object)", () => {
    const r = agentDelivery.resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan: {
        baseDelivery: {} as never,
        resolvedChannel: "whatsapp",
        resolvedTo: "+15551234567",
        deliveryTargetMode: "explicit",
      },
      validateExplicitTarget: true,
    });
    expect(r.resolvedTarget).toBeNull();
    expect(r.resolvedTo).toBe("+15551234567");
  });

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
  }

  function createResult(
    text = "hi",
    options?: {
      usageTotal?: number;
      didSendViaMessagingTool?: boolean;
      messagingToolSentTexts?: string[];
      messagingToolSentMediaUrls?: string[];
    },
  ): EmbeddedPiRunResult {
    return {
      payloads: text ? [{ text }] : [],
      meta: {
        durationMs: 1,
        ...(options?.usageTotal !== undefined
          ? {
              agentMeta: {
                sessionId: "test-session",
                provider: "test",
                model: "test-model",
                usage: { total: options.usageTotal },
              },
            }
          : {}),
      },
      didSendViaMessagingTool: options?.didSendViaMessagingTool,
      messagingToolSentTexts: options?.messagingToolSentTexts,
      messagingToolSentMediaUrls: options?.messagingToolSentMediaUrls,
    };
  }

  async function runDelivery(params: {
    opts: Record<string, unknown>;
    outboundSession?: { key?: string; agentId?: string };
    sessionEntry?: SessionEntry;
    runtime?: RuntimeEnv;
    resultText?: string;
    resultOptions?: {
      usageTotal?: number;
      didSendViaMessagingTool?: boolean;
      messagingToolSentTexts?: string[];
      messagingToolSentMediaUrls?: string[];
    };
    payloads?: ReplyPayload[];
  }) {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = params.runtime ?? createRuntime();
    const result = params.payloads
      ? {
          payloads: params.payloads,
          meta: { durationMs: 1 },
        }
      : createResult(params.resultText, params.resultOptions);

    vi.resetModules();
    const { deliverAgentCommandResult } = await import("./delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: params.opts as never,
      outboundSession: params.outboundSession,
      sessionEntry: params.sessionEntry,
      result,
      payloads: result.payloads,
    });

    return { runtime };
  }

  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockClear();
  });

  it("prefers explicit accountId for outbound delivery", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        accountId: "kev",
        to: "+15551234567",
      },
      sessionEntry: {
        lastAccountId: "default",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "kev" }),
    );
  });

  it("falls back to session accountId for implicit delivery", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "whatsapp",
        lastTo: "+15551234567",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "legacy" }),
    );
  });

  it("does not infer accountId for explicit delivery targets", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
        deliveryTargetMode: "explicit",
      },
      sessionEntry: {
        lastAccountId: "legacy",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    );
  });

  it("skips session accountId when channel differs", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "telegram",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined, channel: "whatsapp", to: "+15551234567" }),
    );
  });

  it("uses session last channel when none is provided", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
      },
      sessionEntry: {
        lastChannel: "telegram",
        lastTo: "123",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "123" }),
    );
  });

  it("uses reply overrides for delivery routing", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        to: "+15551234567",
        replyTo: "#reports",
        replyChannel: "slack",
        replyAccountId: "ops",
      },
      sessionEntry: {
        lastChannel: "telegram",
        lastTo: "123",
        lastAccountId: "legacy",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "slack", to: "#reports", accountId: "ops" }),
    );
  });

  it("uses runContext turn source over stale session last route", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
          currentChannelId: "+15559876543",
          accountId: "work",
        },
      },
      sessionEntry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
        lastAccountId: "wrong",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", to: "+15559876543", accountId: "work" }),
    );
  });

  it("does not reuse session lastTo when runContext source omits currentChannelId", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
        },
      },
      sessionEntry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("uses caller-provided outbound session context when opts.sessionKey is absent", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
      outboundSession: {
        key: "agent:exec:hook:gmail:thread-1",
        agentId: "exec",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:exec:hook:gmail:thread-1",
          agentId: "exec",
        }),
      }),
    );
  });

  it("prefixes nested agent outputs with context", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "ANNOUNCE_SKIP",
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        sessionKey: "agent:main:main",
        runId: "run-announce",
        messageChannel: "webchat",
      },
      sessionEntry: undefined,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const line = String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(line).toContain("[agent:nested]");
    expect(line).toContain("session=agent:main:main");
    expect(line).toContain("run=run-announce");
    expect(line).toContain("channel=webchat");
    expect(line).toContain("ANNOUNCE_SKIP");
  });

  it("treats normalized-empty payload output as no reply", async () => {
    await runDelivery({
      resultText: "   ",
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [
          {
            text: "I hit an execution hiccup while composing the reply, but I am still here. Please resend that request and I will continue in this thread.",
            mediaUrls: [],
          },
        ],
      }),
    );
  });

  it("keeps explicit silent payload behavior for normalized-empty output", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "NO_REPLY",
      opts: {
        message: "hello",
        deliver: false,
      },
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("No reply from agent.");
  });

  it("keeps explicit silent behavior for NO_REPLY with inline directives", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "NO_REPLY [[reply_to_current]]",
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("No reply from agent.");
  });

  it("does not send hiccup fallback when run succeeded but had no deliverable output", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "",
      resultOptions: { didSendViaMessagingTool: true },
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("No reply from agent.");
  });

  it("treats messaging-tool sent text metadata as intentional silence for empty payload runs", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "",
      resultOptions: {
        messagingToolSentTexts: ["sent externally"],
      },
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("No reply from agent.");
  });

  it("preserves audioAsVoice in JSON output envelopes", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      payloads: [{ text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true }],
      opts: {
        message: "hello",
        deliver: false,
        json: true,
      },
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])),
    ).toEqual({
      payloads: [
        {
          text: "voice caption",
          mediaUrl: "file:///tmp/clip.mp3",
          mediaUrls: ["file:///tmp/clip.mp3"],
          audioAsVoice: true,
        },
      ],
      meta: { durationMs: 1 },
    });
  });
});
