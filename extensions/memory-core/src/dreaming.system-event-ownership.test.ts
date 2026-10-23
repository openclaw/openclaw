import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

afterEach(() => {
  vi.restoreAllMocks();
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
  return async (
    context: Parameters<typeof beforeReply>[1],
    cleanedBody = MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  ) => {
    const result = await beforeReply(
      { cleanedBody },
      {
        agentId: "main",
        trigger: "heartbeat",
        workspaceDir: ".",
        ...context,
      },
    );
    expect(error).not.toHaveBeenCalled();
    return result;
  };
}

const handled = { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };
it.each(["heartbeat", "cron"] as const)(
  "handles the public %s trigger without legacy queue state",
  async (trigger) => {
    expect(await createHook()({ trigger, sessionKey: "agent:main:main" })).toEqual(handled);
  },
);

it.each(["heartbeat", "cron"] as const)(
  "preserves disabled dreaming behavior for %s",
  async (trigger) => {
    expect(await createHook(false)({ trigger, sessionKey: "agent:main:main" })).toEqual(
      trigger === "cron"
        ? { handled: true, reason: "memory-core: short-term dreaming disabled" }
        : undefined,
    );
  },
);

it("requires a supported trigger and the managed dreaming token", async () => {
  const beforeReply = createHook();
  expect(await beforeReply({ trigger: "user" })).toBeUndefined();
  expect(await beforeReply({ trigger: "cron" }, "ordinary reminder")).toBeUndefined();
});
