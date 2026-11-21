import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
const context: OpenClawPluginToolContext<2> = {
  agentId: "fixture-agent",
  sessionKey: "fixture-session",
  sessionId: "fixture-incarnation",
  senderIsOwner: true,
  assertInvocationCurrent: () => {},
};

async function registered() {
  const registrations = new Map<string, Parameters<OpenClawPluginApi["registerTool"]>[0]>();
  const api = createTestPluginApi({
    pluginConfig: {
      gatewayUrl: "https://simlock.example.invalid",
      token: "synthetic-fixture-token",
    },
    registerTool: (factory, options) => {
      registrations.set(options?.name ?? "", factory);
    },
  });
  await plugin.register(api);
  function create(name: string, ctx = context) {
    const factory = registrations.get(name);
    if (
      !factory ||
      typeof factory === "function" ||
      !("contextVersion" in factory) ||
      factory.contextVersion !== 2
    ) {
      throw new Error("Missing version-2 factory");
    }
    return factory.create(ctx);
  }
  return { registrations, create };
}

function single(value: ReturnType<Awaited<ReturnType<typeof registered>>["create"]>) {
  if (!value || Array.isArray(value)) {
    throw new Error("Expected one tool");
  }
  return value;
}

describe("Simlock public plugin entry", () => {
  it("registers separate read-only/mutation tools, all with live authority", async () => {
    const registry = await registered();
    expect([...registry.registrations.keys()]).toEqual([
      "simlock_discover",
      "simlock_acquire",
      "simlock_status",
      "simlock_renew",
      "simlock_observe",
      "simlock_ui",
      "simlock_release",
    ]);
    for (const name of registry.registrations.keys()) {
      expect(single(registry.create(name)).name).toBe(name);
      expect(registry.create(name, { ...context, senderIsOwner: false })).toBeUndefined();
      expect(registry.create(name, { ...context, sessionId: undefined })).toBeUndefined();
    }
  });

  it("does not allow a read-only observation grant to issue UI mutations", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const registry = await registered();
    const observe = single(registry.create("simlock_observe"));
    const result = await observe.execute("call", {
      lease: "opaque-fixture-handle",
      action: "open",
    });
    expect(result.details).toMatchObject({ error: { code: "UI_ARGUMENTS" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("delivers only redacted errors after authority revocation", async () => {
    const registry = await registered();
    const tool = single(
      registry.create("simlock_acquire", {
        ...context,
        assertInvocationCurrent: () => {
          throw new Error("private-token-and-session");
        },
      }),
    );
    const result = await tool.execute("call", { platform: "ios" });
    expect(result.details).toMatchObject({ error: { code: "UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain("private-token-and-session");
  });
});
