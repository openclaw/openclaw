import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import * as taskStores from "./task-store.js";
import { createTerminalStoreFixture } from "./task-store.test-support.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("A2A gateway account lifecycle", () => {
  it("registers exact plugin-owned routes and removes them when the account stops", async () => {
    const fixture = createA2aGatewayFixture();
    const lifecycle = a2aChannelPlugin.gateway!.startAccount!(fixture.ctx);

    await vi.waitFor(() => expect(fixture.ctx.getStatus().lifecycle).toBe("ready"));
    expect(fixture.registry.httpRoutes).toEqual(
      ["/.well-known/agent-card.json", "/.well-known/agent.json", "/a2a/v1"].map((path) =>
        expect.objectContaining({ path, auth: "plugin", match: "exact", pluginId: "a2a" }),
      ),
    );
    expect(fixture.ctx.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );

    fixture.controller.abort();
    await lifecycle;

    expect(fixture.registry.httpRoutes).toEqual([]);
    expect(fixture.ctx.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "stopped", running: false, connected: false }),
    );
  });

  it("restores terminal state before admitting any HTTP routes", async () => {
    const fixture = createA2aGatewayFixture();
    const durable = createTerminalStoreFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(taskStores.openTerminalStore).mockReturnValue({
      ...durable,
      entries: async () => {
        await gate;
        return durable.entries();
      },
    });
    const lifecycle = a2aChannelPlugin.gateway!.startAccount!(fixture.ctx);
    expect(fixture.registry.httpRoutes).toEqual([]);
    release();
    await vi.waitFor(() => expect(fixture.ctx.getStatus().lifecycle).toBe("ready"));
    fixture.controller.abort();
    await lifecycle;
  });

  it("rolls back already registered routes when a later route belongs to another plugin", async () => {
    const fixture = createA2aGatewayFixture();
    const releaseConflict = registerPluginHttpRoute({
      path: "/.well-known/agent.json",
      auth: "plugin",
      match: "exact",
      pluginId: "other-plugin",
      handler: () => true,
      throwOnFailure: true,
    });

    await expect(a2aChannelPlugin.gateway!.startAccount!(fixture.ctx)).rejects.toThrow(
      /other-plugin/,
    );

    expect(fixture.registry.httpRoutes).toEqual([
      expect.objectContaining({
        path: "/.well-known/agent.json",
        pluginId: "other-plugin",
      }),
    ]);
    expect(fixture.ctx.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
    releaseConflict();
  });

  it("fails closed without configured peers instead of exposing discovery routes", async () => {
    const fixture = createA2aGatewayFixture();
    fixture.account.configured = false;

    await expect(a2aChannelPlugin.gateway!.startAccount!(fixture.ctx)).rejects.toThrow(
      /not configured/,
    );

    expect(fixture.registry.httpRoutes).toEqual([]);
  });
});
