import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import type { WebhookTarget } from "./monitor-shared.js";
import { registerBlueBubblesWebhookTarget } from "./monitor.js";
import type { OpenClawConfig } from "./runtime-api.js";

function createTarget(): WebhookTarget {
  return {
    account: { accountId: "default" } as WebhookTarget["account"],
    config: {} as OpenClawConfig,
    runtime: {},
    core: {} as WebhookTarget["core"],
    path: "/bluebubbles-webhook",
  };
}

describe("registerBlueBubblesWebhookTarget", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("registers and unregisters plugin HTTP route at path boundaries", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    const unregisterA = registerBlueBubblesWebhookTarget(createTarget());
    const unregisterB = registerBlueBubblesWebhookTarget(createTarget());

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toEqual(
      expect.objectContaining({
        pluginId: "bluebubbles",
        path: "/bluebubbles-webhook",
        source: "bluebubbles-webhook",
      }),
    );

    unregisterA();
    expect(registry.httpRoutes).toHaveLength(1);
    unregisterB();
    expect(registry.httpRoutes).toHaveLength(0);
  });
});
