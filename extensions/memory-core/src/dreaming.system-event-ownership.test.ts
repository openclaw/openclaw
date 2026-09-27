import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  enqueueSystemEvent,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

let previousConfig: ReturnType<typeof getRuntimeConfigSnapshot>;

beforeEach(() => {
  previousConfig = getRuntimeConfigSnapshot();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  if (previousConfig) {
    setRuntimeConfigSnapshot(previousConfig);
  } else {
    clearRuntimeConfigSnapshot();
  }
});

it.each(
  ["global", "global:heartbeat"].flatMap((sessionKey) =>
    ["main", "research"].map((queuedAgentId) => ({ sessionKey, queuedAgentId })),
  ),
)(
  "checks $sessionKey against its heartbeat owner, with an event for $queuedAgentId",
  async ({ sessionKey, queuedAgentId }) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true }, research: {} } },
      session: { scope: "global" },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    };
    setRuntimeConfigSnapshot(config);
    const on = vi.fn<OpenClawPluginApi["on"]>();
    const api = createTestPluginApi({ id: "memory-core", config, on });
    registerShortTermPromotionDreaming(api);
    const registration = on.mock.calls.find(([name]) => name === "before_agent_reply");
    expect(registration).toBeDefined();
    const beforeReply = registration![1] as Parameters<typeof api.on<"before_agent_reply">>[1];
    expect(
      enqueueSystemEvent(MEMORY_DREAMING_SYSTEM_EVENT_TEXT, {
        sessionKey: `agent:${queuedAgentId}:global`,
        contextKey: "cron:memory-dreaming",
      }),
    ).toBe(true);

    const result = await beforeReply(
      { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
      { agentId: "research", trigger: "heartbeat", sessionKey, workspaceDir: "." },
    );

    expect(result).toEqual(
      queuedAgentId === "research"
        ? { handled: true, reason: "memory-core: short-term dreaming disabled" }
        : undefined,
    );
  },
);
