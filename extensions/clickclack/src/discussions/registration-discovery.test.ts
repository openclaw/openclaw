import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRecord,
  createPluginRegistry,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { registerSessionDiscussionProvider } from "openclaw/plugin-sdk/session-discussion";
import { createSessionVisibilityChecker } from "openclaw/plugin-sdk/session-visibility";
import { afterEach, expect, it, vi } from "vitest";
import entry from "../../index.js";
import { createHarness } from "./service-test-support.js";

vi.mock("openclaw/plugin-sdk/session-discussion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-discussion")>()),
  registerSessionDiscussionProvider: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.mocked(registerSessionDiscussionProvider).mockClear();
});

function register(registrationMode: "discovery" | "tool-discovery" | "full") {
  const harness = createHarness({ label: "Release coordination" });
  cleanups.push(() => harness.service.cleanup());
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const registerRuntimeLifecycle =
    vi.fn<OpenClawPluginApi["lifecycle"]["registerRuntimeLifecycle"]>();
  const on = vi.fn<OpenClawPluginApi["on"]>();
  vi.spyOn(createSessionVisibilityChecker, "registerScopedAccessProvider").mockReturnValue(
    () => undefined,
  );
  const api = createTestPluginApi({
    runtime: harness.runtime,
    registrationMode,
    registerService,
    registerRuntimeLifecycle,
    on,
  });
  const builder = createPluginRegistry({
    logger: api.logger,
    runtime: harness.runtime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "clickclack",
    source: "/synthetic/clickclack/index.ts",
    contracts: { tools: ["discussion"] },
  });
  builder.registry.plugins.push(record);
  const host = builder.createApi(record, { config: harness.config, registrationMode });
  cleanups.push(async () => {
    for (const [lifecycle] of registerRuntimeLifecycle.mock.calls) {
      await lifecycle.cleanup?.({ reason: "disable" });
    }
    await disposePluginRegistryInstances(builder.registry);
  });
  entry.register({ ...api, registerTool: host.registerTool });
  // Runtime adoption matches declared names before evaluating factories.
  expect(builder.registry.tools.map((tool) => tool.names)).toEqual([["discussion"]]);
  return {
    harness,
    registerService,
    registerRuntimeLifecycle,
    on,
    tool(sessionKey = "agent:main:main") {
      const tool = builder.registry.tools[0]!.factory({ sessionKey });
      assert(tool && !Array.isArray(tool));
      return tool;
    },
  };
}

it.each(["discovery", "tool-discovery"] as const)(
  "keeps the %s declaration stable without a runtime donor",
  async (mode) => {
    const discovery = register(mode);
    const tool = discovery.tool();
    expect((await tool.execute("discovery-call", {})).details).toEqual({ gated: true });
    expect(discovery.registerService).not.toHaveBeenCalled();
    expect(discovery.registerRuntimeLifecycle).not.toHaveBeenCalled();
    expect(discovery.on).not.toHaveBeenCalled();
    expect(registerSessionDiscussionProvider).not.toHaveBeenCalled();
    expect(discovery.harness.workspaces).not.toHaveBeenCalled();
    expect(discovery.harness.messagePage).not.toHaveBeenCalled();

    const runtime = register("full").tool();
    expect(tool.name).toBe(runtime.name);
    expect(tool.description).toBe(runtime.description);
    expect(tool.parameters).toEqual(runtime.parameters);
  },
);

it("executes through the full scoped service and observes live account authorization", async () => {
  const registration = register("full");
  const { harness } = registration;
  const sessionKey = "agent:main:main";
  const provider = vi.mocked(registerSessionDiscussionProvider).mock.calls[0]?.[0];
  assert(provider);
  await provider.open({ sessionKey, agentId: "main" });
  const tool = registration.tool(sessionKey);
  expect(await tool.execute("bound-call", {})).toMatchObject({
    content: [{ type: "text", text: "The bound discussion has no messages yet." }],
    details: { bound: true, limit: 30, channelId: "chn_discussion" },
  });
  expect(harness.messagePage).toHaveBeenCalledExactlyOnceWith("chn_discussion", expect.any(Number));

  const unbound = registration.tool("agent:main:unbound");
  expect((await unbound.execute("unbound-call", {})).details).toMatchObject({ bound: false });
  harness.config.channels!.clickclack!.enabled = false;
  expect((await tool.execute("disabled-call", {})).details).toMatchObject({ bound: false });
  expect(harness.messagePage).toHaveBeenCalledTimes(1);
});
