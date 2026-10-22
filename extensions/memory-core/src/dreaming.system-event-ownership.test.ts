import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as systemEvents from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

beforeEach(resetSystemEventsForTest);

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
});

function createHook(enabled = true) {
  const config: OpenClawConfig = {
    agents: { entries: { main: {}, research: {} } },
    session: { scope: "global" },
    plugins: {
      entries: {
        "memory-core": { config: { dreaming: { enabled, phases: { deep: { limit: 0 } } } } },
      },
    },
  };
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const runtime = createPluginRuntimeMock();
  runtime.config.current = () => config;
  const api = createTestPluginApi({ id: "memory-core", config, on, runtime });
  const error = vi.spyOn(api.logger, "error");
  registerShortTermPromotionDreaming(api);
  const registration = on.mock.calls.find(([name]) => name === "before_agent_reply");
  expect(registration).toBeDefined();
  const beforeReply = registration![1] as Parameters<typeof api.on<"before_agent_reply">>[1];
  return async (context: Parameters<typeof beforeReply>[1]) => {
    const result = await beforeReply(event, {
      agentId: "main",
      trigger: "heartbeat",
      workspaceDir: ".",
      ...context,
    });
    expect(error).not.toHaveBeenCalled();
    return result;
  };
}

const event = { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT };
const handled = { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };
it.each([
  ...["global", "agent:research:global:heartbeat"].flatMap((sessionKey) =>
    ["main", "research"].map(
      (queuedAgentId) =>
        [
          sessionKey,
          "agent:research:global",
          `agent:${queuedAgentId}:global`,
          queuedAgentId === "research" ? handled : undefined,
          "research",
        ] as const,
    ),
  ),
  ["agent:main:heartbeat", undefined, undefined, undefined],
  ["agent:main:heartbeat:heartbeat", "agent:main:heartbeat", "agent:main:heartbeat", handled],
  [
    "agent:main:main:heartbeat",
    "agent:main:main:heartbeat:heartbeat",
    "agent:main:main:heartbeat:heartbeat",
    handled,
  ],
  ["agent:main:heartbeat", undefined, "agent:main:heartbeat", handled],
  ["agent:main:main:heartbeat", undefined, "agent:main:main", undefined],
  ["agent:main", undefined, undefined, undefined],
] as const)(
  "routes heartbeat %s through queue %s with pending event %s",
  async (sessionKey, queueKey, pendingKey, expected, agentId?: string) => {
    const beforeReply = createHook();
    if (pendingKey) {
      systemEvents.enqueueSystemEvent(MEMORY_DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey: pendingKey,
        contextKey: "cron:memory-dreaming",
      });
    }
    expect(
      await beforeReply({
        agentId: agentId ?? "main",
        sessionKey,
        heartbeatEventQueueSessionKey: queueKey,
      }),
    ).toEqual(expected);
  },
);

it.each(["heartbeat", "cron"])(
  "does not inspect queues when dreaming is disabled on %s",
  async (trigger) => {
    const beforeReply = createHook(false);
    const peek = vi.spyOn(systemEvents, "peekSystemEventEntries");
    const result = await beforeReply({
      trigger,
      sessionKey: "agent:main:heartbeat",
    });
    expect(result).toEqual(
      trigger === "cron"
        ? { handled: true, reason: "memory-core: short-term dreaming disabled" }
        : undefined,
    );
    expect(peek).not.toHaveBeenCalled();
  },
);
