import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../test-utils/plugin-api.js";
import { createPluginRuntimeMock } from "../test-utils/plugin-runtime-mock.js";
import plugin from "./index.js";

describe("feishu plugin register SecretRef regression", () => {
  it("does not resolve SecretRefs while registering tools", () => {
    const api = createTestPluginApi({
      id: plugin.id,
      name: plugin.name,
      source: "extensions/feishu/index.ts",
      config: {
        channels: {
          feishu: {
            enabled: true,
            accounts: {
              main: {
                appId: { source: "file", provider: "default", id: "path/to/app-id" },
                appSecret: { source: "file", provider: "default", id: "path/to/app-secret" },
                tools: {
                  chat: true,
                  doc: true,
                  drive: true,
                  perm: true,
                  wiki: true,
                },
              },
            },
          },
        },
      } as never,
      runtime: createPluginRuntimeMock(),
    });

    expect(() => plugin.register(api)).not.toThrow();
  });
});
