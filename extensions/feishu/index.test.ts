import { describe, expect, it, vi } from "vitest";
import { assertBundledChannelEntries } from "../../test/helpers/bundled-channel-entry.ts";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import entry from "./index.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import setupEntry from "./setup-entry.js";

function createToolEnabledConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          main: {
            appId: "app-main",
            appSecret: "secret-main", // pragma: allowlist secret
            tools: {
              doc: true,
              chat: true,
              wiki: true,
              drive: true,
              perm: true,
              bitable: true,
            },
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("feishu bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "feishu",
    expectedName: "Feishu",
    setupEntry,
  });

  it("does not register tools or hooks twice when full registration reruns", () => {
    const registerTool = vi.fn();
    const on = vi.fn();

    const api = createTestPluginApi({
      config: createToolEnabledConfig(),
      registerTool,
      on,
    });

    entry.register(api);

    const firstToolRegistrations = registerTool.mock.calls.length;
    const firstHookRegistrations = on.mock.calls.length;

    entry.register(api);

    expect(firstToolRegistrations).toBeGreaterThan(0);
    expect(firstHookRegistrations).toBe(3);
    expect(registerTool).toHaveBeenCalledTimes(firstToolRegistrations);
    expect(on).toHaveBeenCalledTimes(firstHookRegistrations);
  });
});
