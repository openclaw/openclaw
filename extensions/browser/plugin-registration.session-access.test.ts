import type { PluginControlUiDescriptor } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import browserPlugin from "./index.js";

it("declares a session-writer dashboard while preserving the global admin method", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const descriptors: PluginControlUiDescriptor[] = [];
    const methods = new Map<string, unknown>();
    browserPlugin.register(
      createTestPluginApi({
        id: "browser",
        runtime: createPluginRuntimeMock({
          state: {
            openSyncKeyedStore: (options) =>
              createPluginStateSyncKeyedStoreForTests("browser", options),
            openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
          },
        }),
        registerControlUiDescriptor: (descriptor) => descriptors.push(descriptor),
        registerGatewayMethod: (name, _handler, options) => {
          methods.set(name, options);
        },
      }),
    );
    expect(descriptors).toContainEqual(
      expect.objectContaining({
        id: "dashboard",
        surface: "widget",
        label: "Browser",
        requiredScopes: ["operator.sessions.write"],
      }),
    );
    expect(methods.get("browser.request")).toMatchObject({ scope: "operator.admin" });
    expect(methods.get("browser.dashboard.request")).toMatchObject({
      scope: "operator.write",
      sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "browser" },
    });
  });
});
