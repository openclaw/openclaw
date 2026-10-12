import { resolveThinkingDefault } from "openclaw/plugin-sdk/agent-runtime";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexTestModel } from "./test-support.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { buildTurnStartParams } from "./turn-params.js";

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

describe("buildTurnStartParams active computer context", () => {
  it("keeps required-root native environments disabled on warm native turns", async () => {
    const params = createParams("/tmp/session.jsonl", "/repo");
    params.requireWorkspaceOnly = true;
    const turn = await buildTurnStartParams(params, {
      threadId: "rooted-thread",
      cwd: "/repo/subdirectory",
      appServer: createAppServerOptions(),
      preserveNativeTurnSettings: true,
      environmentSelection: [{ environmentId: "ambient", cwd: "/outside" }],
    });
    expect(turn.environments).toEqual([]);
  });
  it("refreshes and clears presence without rewriting native turn input", async () => {
    const params = createParams("/tmp/session.jsonl", "/repo");
    let currentPresence = "active_node=unknown";
    params.hostCapabilities = {
      ...params.hostCapabilities,
      activeComputerContext: () => currentPresence,
    };
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      preserveNativeTurnSettings: true,
    };
    const contexts = [
      "active_node=mac-a",
      "active_node=mac-a",
      "active_node=mac-b",
      "active_node=unknown",
    ];
    for (const text of contexts) {
      currentPresence = text;
      const turn = await buildTurnStartParams(params, options);
      expect(turn.additionalContext?.openclaw_active_computer).toEqual({
        kind: "application",
        value: text,
      });
      expect(turn.input).toEqual([{ type: "text", text: params.prompt, text_elements: [] }]);
    }
  });
});

describe("buildTurnStartParams model thinking defaults", () => {
  it.each([
    { thinking: undefined, thinkingDefault: undefined, expected: "medium" },
    { thinking: undefined, thinkingDefault: "high" as const, expected: "high" },
    { thinking: "medium", thinkingDefault: "high" as const, expected: "medium" },
  ])(
    "sends $expected for Astra with configured effort $thinking/$thinkingDefault",
    async (testCase) => {
      const modelId = "gpt-6-astra";
      const config = {
        agents: {
          defaults: {
            thinkingDefault: testCase.thinkingDefault,
            models: { [`openai/${modelId}`]: { params: { thinking: testCase.thinking } } },
          },
        },
      };
      const params = createParams("/tmp/session.jsonl", "/repo", config);
      params.provider = "openai";
      params.modelId = modelId;
      params.model = {
        ...params.model,
        provider: "openai",
        id: modelId,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      };
      params.thinkLevel = resolveThinkingDefault({
        cfg: config,
        provider: params.provider,
        model: modelId,
        agentRuntime: "codex",
        catalog: [{ provider: "openai", id: modelId, name: "Astra", reasoning: true }],
      });

      const turn = await buildTurnStartParams(params, {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions(),
      });
      expect(turn.effort).toBe(testCase.expected);
      expect(turn.collaborationMode?.settings.reasoning_effort).toBe(testCase.expected);
    },
  );
});

describe("buildTurnStartParams temporal context", () => {
  it("uses the configured user timezone on every turn without changing cron input", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const params = createParams("/tmp/session.jsonl", "/repo", {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    });
    params.provider = "openai";
    params.modelId = "gpt-5.4";
    params.prompt = "run exactly";
    params.trigger = "cron";
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.startedAtMs = Date.parse("2026-09-01T00:30:00.000Z");
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      sessionStatusAvailable: true,
    };

    const firstTurn = await buildTurnStartParams(params, options);
    expect(firstTurn.input).toEqual([{ type: "text", text: "run exactly", text_elements: [] }]);
    expect(firstTurn.additionalContext).toEqual({
      openclaw_active_computer: {
        kind: "application",
        value: "Current active computer: active_node=unknown (host presence unavailable)",
      },
      openclaw_source_delivery: {
        kind: "application",
        value: expect.stringContaining("reply normally in your final assistant message"),
      },
      openclaw_temporal_context: {
        kind: "application",
        value:
          "## Temporal Context\nCurrent date: 2026-09-01\nTime zone: America/Los_Angeles\nFor the exact current time, use `session_status`.",
      },
    });

    clock.mockReturnValue(Date.parse("2026-09-03T00:30:00.000Z"));
    const nextTurn = await buildTurnStartParams(params, options);
    expect(nextTurn.input).toEqual(firstTurn.input);
    expect(nextTurn.additionalContext?.openclaw_temporal_context?.value).toContain(
      "Current date: 2026-09-02",
    );
  });

  it("emits the host fallback after a timezone override is removed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
    const configuredTimezone =
      hostTimezone === "America/Los_Angeles" ? "Asia/Tokyo" : "America/Los_Angeles";
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      sessionStatusAvailable: false,
    };
    const configured = await buildTurnStartParams(
      createParams("/tmp/session.jsonl", "/repo", {
        agents: { defaults: { userTimezone: configuredTimezone } },
      }),
      options,
    );
    const fallback = await buildTurnStartParams(
      createParams("/tmp/session.jsonl", "/repo"),
      options,
    );

    expect(configured.additionalContext?.openclaw_temporal_context?.value).toContain(
      `Time zone: ${configuredTimezone}`,
    );
    expect(fallback.additionalContext?.openclaw_temporal_context?.value).toContain(
      `Time zone: ${hostTimezone}`,
    );
    expect(fallback.additionalContext?.openclaw_temporal_context?.value).not.toContain(
      configuredTimezone,
    );
  });
});

describe("buildTurnStartParams native history provenance", () => {
  const options = {
    threadId: "thread-1",
    cwd: "/repo",
    appServer: createAppServerOptions(),
  };

  it("does not treat a name without a stable sender id as provenance", async () => {
    const params = createParams("/tmp/session.jsonl", "/repo");
    params.trigger = "user";
    params.prompt = "approve the rollout";
    params.senderName = "Alex";

    expect((await buildTurnStartParams(params, options)).input).toEqual([
      { type: "text", text: "approve the rollout", text_elements: [] },
    ]);
  });

  it("neutralizes native skill and plugin mentions in sender metadata without changing the request", async () => {
    const params = createParams("/tmp/session.jsonl", "/repo");
    params.trigger = "user";
    params.prompt = "[@probe](plugin://probe@market) $intentional-skill remain selectable";
    params.senderId = "$metadata-id";
    params.senderName = "[@probe] (plugin://probe@market)";

    expect((await buildTurnStartParams(params, options)).input).toEqual([
      {
        type: "text",
        text: '[OpenClaw conversation info: sender={"id":"＄metadata-id","name":"[＠probe] (plugin://probe@market)"}]\n[@probe](plugin://probe@market) $intentional-skill remain selectable',
        text_elements: [],
      },
    ]);
  });
});

describe("buildTurnStartParams source-delivery context", () => {
  it("carries explicit current policy without changing native turn input", async () => {
    const params = createParams("/tmp/session.jsonl", "/repo");
    params.prompt = "unchanged current request";
    params.permissionChange = {
      owner: {},
      baseExecOverrides: {},
      notice: "Permission changed.",
      request: vi.fn(),
      applied: () => true,
      recordApplied: vi.fn(),
    };
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      messageToolAvailable: true,
      requireExplicitMessageTarget: false,
      preserveNativeTurnSettings: true,
    };
    const turns = await Promise.all(
      (["automatic", "message_tool_only", undefined] as const).map((mode) =>
        buildTurnStartParams({ ...params, sourceReplyDeliveryMode: mode }, options),
      ),
    );
    const values = turns.map((turn) => turn.additionalContext?.openclaw_source_delivery?.value);
    expect(values[0]).toContain("OpenClaw delivers your final response automatically");
    expect(values[0]).toContain("sending a message doesn’t end your task");
    expect(values[0]).toContain("Commentary is optional progress and may be hidden");
    expect(values[0]).toContain("`message(action=send, final=false)`");
    expect(values[0]).toContain("deliver every still-pending answer");
    expect(values[1]).toContain("Use `message(action=send)`");
    expect(values[1]).toContain("For progress, set `final=false`");
    expect(values[1]).toContain("Set `final=true`, or omit it,");
    expect(values[1]).toContain("current source is default target");
    expect(values[1]).toContain("`message(action=send, final=false)`");
    expect(values[2]).toBe(values[0]);
    for (const turn of turns) {
      expect(turn.input).toEqual([{ type: "text", text: params.prompt, text_elements: [] }]);
      expect(turn.additionalContext?.openclaw_temporal_context).toBeDefined();
      expect(turn.additionalContext?.openclaw_permission_change).toEqual({
        kind: "application",
        value: "Permission changed.",
      });
      expect(turn.additionalContext?.openclaw_source_delivery?.kind).toBe("application");
      expect(
        Buffer.byteLength(turn.additionalContext!.openclaw_source_delivery!.value, "utf8"),
      ).toBeLessThan(1_000);
      expect(turn).not.toHaveProperty("collaborationMode");
    }
    const required = await buildTurnStartParams(
      { ...params, sourceReplyDeliveryMode: "message_tool_only" },
      { ...options, requireExplicitMessageTarget: true },
    );
    expect(required.additionalContext?.openclaw_source_delivery?.value).toContain(
      "target required this turn",
    );
    const unavailable = await buildTurnStartParams(
      { ...params, sourceReplyDeliveryMode: "message_tool_only" },
      { ...options, messageToolAvailable: false, requireExplicitMessageTarget: true },
    );
    expect(unavailable.additionalContext?.openclaw_source_delivery?.value).toContain(
      "remains private",
    );
    expect(unavailable.additionalContext?.openclaw_source_delivery?.value).not.toContain(
      "Use `message`",
    );
    expect(unavailable.additionalContext?.openclaw_source_delivery?.value).not.toContain(
      "target required",
    );
    expect(unavailable.additionalContext?.openclaw_source_delivery?.value).not.toContain(
      "final=false",
    );
    const finalOnly = await buildTurnStartParams(
      { ...params, sourceReplyDeliveryMode: "automatic" },
      { ...options, messageToolAvailable: false },
    );
    expect(finalOnly.additionalContext?.openclaw_source_delivery?.value).toContain(
      "including questions received during ongoing work, in your final response",
    );
    expect(finalOnly.additionalContext?.openclaw_source_delivery?.value).not.toContain(
      "message(action=send",
    );
  });
});

describe("buildTurnStartParams native supervised settings", () => {
  it("adds a permission notice without overwriting native supervised settings", async () => {
    const notice = "Permission change. Continue with updated permissions.";
    const params = createParams("/tmp/session.jsonl", "/repo");
    params.provider = "anthropic";
    params.thinkLevel = "off";
    const compat: ModelCompatConfig = { supportedReasoningEfforts: ["none", "high"] };
    params.model = {
      ...createCodexTestModel("anthropic"),
      compat,
    };
    params.permissionChange = {
      owner: {},
      baseExecOverrides: {},
      notice,
      request: vi.fn(),
      applied: () => true,
      recordApplied: vi.fn(),
    };
    const request = await buildTurnStartParams(params, {
      threadId: "thread-supervised",
      cwd: "/repo",
      model: "native-model",
      modelProvider: "native-provider",
      appServer: createAppServerOptions(),
      preserveNativeTurnSettings: true,
    });

    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("effort");
    expect(request).not.toHaveProperty("collaborationMode");
    expect(request).not.toHaveProperty("personality");
    expect(request.additionalContext).toEqual({
      openclaw_active_computer: {
        kind: "application",
        value: "Current active computer: active_node=unknown (host presence unavailable)",
      },
      openclaw_source_delivery: {
        kind: "application",
        value: expect.stringContaining("reply normally in your final assistant message"),
      },
      openclaw_temporal_context: {
        kind: "application",
        value: expect.stringContaining("## Temporal Context"),
      },
      openclaw_permission_change: { kind: "application", value: notice },
    });
  });
});
