import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as systemEvents from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

let previousConfig: ReturnType<typeof getRuntimeConfigSnapshot>;

beforeEach(() => {
  previousConfig = getRuntimeConfigSnapshot();
  resetSystemEventsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  if (previousConfig) {
    setRuntimeConfigSnapshot(previousConfig);
  } else {
    clearRuntimeConfigSnapshot();
  }
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
  setRuntimeConfigSnapshot(config);
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const runtime = createPluginRuntimeMock();
  runtime.config.current = () => config;
  const api = createTestPluginApi({
    id: "memory-core",
    config,
    on,
    runtime,
  });
  const error = vi.spyOn(api.logger, "error");
  registerShortTermPromotionDreaming(api);
  const registration = on.mock.calls.find(([name]) => name === "before_agent_reply");
  expect(registration).toBeDefined();
  return {
    beforeReply: registration![1] as Parameters<typeof api.on<"before_agent_reply">>[1],
    error,
  };
}

const event = { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT };
const handled = { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };

it.each(
  ["global", "agent:research:global:heartbeat"].flatMap((sessionKey) =>
    ["main", "research"].map((queuedAgentId) => ({ sessionKey, queuedAgentId })),
  ),
)(
  "checks $sessionKey against its heartbeat owner, with an event for $queuedAgentId",
  async ({ sessionKey, queuedAgentId }) => {
    const { beforeReply, error } = createHook();
    systemEvents.enqueueSystemEvent(MEMORY_DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey: `agent:${queuedAgentId}:global`,
      contextKey: "cron:memory-dreaming",
    });
    const result = await beforeReply(event, {
      agentId: "research",
      trigger: "heartbeat",
      sessionKey,
      heartbeatEventQueueSessionKey: "agent:research:global",
      workspaceDir: ".",
    });
    expect(result).toEqual(queuedAgentId === "research" ? handled : undefined);
    expect(error).not.toHaveBeenCalled();
  },
);

it.each([
  {
    sessionKey: "agent:main:heartbeat",
    queueKey: undefined,
    pendingKey: undefined,
    expected: undefined,
  },
  {
    sessionKey: "agent:main:heartbeat:heartbeat",
    queueKey: "agent:main:heartbeat",
    pendingKey: "agent:main:heartbeat",
    expected: handled,
  },
  {
    sessionKey: "agent:main:main:heartbeat",
    queueKey: "agent:main:main:heartbeat:heartbeat",
    pendingKey: "agent:main:main:heartbeat:heartbeat",
    expected: handled,
  },
  {
    sessionKey: "agent:main:heartbeat",
    queueKey: undefined,
    pendingKey: "agent:main:heartbeat",
    expected: handled,
  },
  {
    sessionKey: "agent:main:main:heartbeat",
    queueKey: undefined,
    pendingKey: "agent:main:main",
    expected: undefined,
  },
  { sessionKey: "agent:main", queueKey: undefined, pendingKey: undefined, expected: undefined },
])(
  "uses only the supplied queue or current session: $sessionKey / $queueKey",
  async ({ sessionKey, queueKey, pendingKey, expected }) => {
    const { beforeReply, error } = createHook();
    if (pendingKey) {
      systemEvents.enqueueSystemEvent(MEMORY_DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey: pendingKey,
        contextKey: "cron:memory-dreaming",
      });
    }
    expect(
      await beforeReply(event, {
        agentId: "main",
        trigger: "heartbeat",
        sessionKey,
        heartbeatEventQueueSessionKey: queueKey,
        workspaceDir: ".",
      }),
    ).toEqual(expected);
    expect(error).not.toHaveBeenCalled();
  },
);

it.each(["heartbeat", "cron"])(
  "does not inspect queues when dreaming is disabled on %s",
  async (trigger) => {
    const { beforeReply, error } = createHook(false);
    const peek = vi.spyOn(systemEvents, "peekSystemEventEntries");
    const result = await beforeReply(event, {
      agentId: "main",
      trigger,
      sessionKey: "agent:main:heartbeat",
    });
    expect(result).toEqual(
      trigger === "cron"
        ? { handled: true, reason: "memory-core: short-term dreaming disabled" }
        : undefined,
    );
    expect(peek).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);
