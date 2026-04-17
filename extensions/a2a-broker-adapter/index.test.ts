import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "./api.js";
import {
  createConfiguredA2ABrokerClient,
  resolveA2ABrokerAdapterPluginConfig,
  shouldUseStandaloneBrokerSessionsSendAdapter,
} from "./config.js";
import plugin from "./index.js";

describe("a2a-broker-adapter plugin", () => {
  it("registers gateway methods plus an explicit activation migration", async () => {
    const registerConfigMigration = vi.fn();
    const registerGatewayMethod = vi.fn();

    await plugin.register(
      createTestPluginApi({
        id: A2A_BROKER_ADAPTER_PLUGIN_ID,
        name: "A2A Broker Adapter",
        registerConfigMigration,
        registerGatewayMethod,
      }),
    );

    expect(registerGatewayMethod.mock.calls.map((call) => [call[0], call[2]?.scope])).toEqual([
      ["a2a.task.request", "operator.write"],
      ["a2a.task.update", "operator.write"],
      ["a2a.task.cancel", "operator.write"],
      ["a2a.task.status", "operator.read"],
    ]);

    expect(registerConfigMigration).toHaveBeenCalledTimes(1);
    const migrate = registerConfigMigration.mock.calls[0]?.[0] as
      | ((config: Record<string, unknown>) => unknown)
      | undefined;
    expect(migrate).toBeTypeOf("function");
    if (!migrate) {
      throw new Error("missing config migration");
    }

    expect(
      migrate({
        plugins: {
          allow: ["browser"],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      }),
    ).toMatchObject({
      config: {
        plugins: {
          allow: ["browser", A2A_BROKER_ADAPTER_PLUGIN_ID],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      },
      changes: [
        "a2a-broker-adapter: auto-enabled (existing config detected)",
        "a2a-broker-adapter: added to plugins.allow (existing config detected)",
      ],
    });

    expect(
      migrate({
        plugins: {
          allow: ["browser"],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      }),
    ).toMatchObject({
      config: {
        plugins: {
          allow: ["browser", A2A_BROKER_ADAPTER_PLUGIN_ID],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      },
      changes: ["a2a-broker-adapter: added to plugins.allow (existing config detected)"],
    });

    expect(
      migrate({
        plugins: {
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: false,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("keeps standalone broker routing off until activation is explicit and baseUrl is present", () => {
    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          allow: [A2A_BROKER_ADAPTER_PLUGIN_ID],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(true);

    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          allow: ["browser"],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(false);

    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: false,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(false);

    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {},
            },
          },
        },
      } as never),
    ).toBe(false);

    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          allow: [A2A_BROKER_ADAPTER_PLUGIN_ID],
          deny: [A2A_BROKER_ADAPTER_PLUGIN_ID],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(false);

    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          enabled: false,
          allow: [A2A_BROKER_ADAPTER_PLUGIN_ID],
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(false);

    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(true);
  });

  it("re-evaluates explicit activation on each call so reload-style disable flips routing back off", () => {
    const enabledConfig = {
      plugins: {
        entries: {
          [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
            enabled: true,
            config: {
              baseUrl: "https://broker.example.com",
            },
          },
        },
      },
    } as never;
    const disabledConfig = {
      plugins: {
        entries: {
          [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
            enabled: false,
            config: {
              baseUrl: "https://broker.example.com",
            },
          },
        },
      },
    } as never;

    expect(shouldUseStandaloneBrokerSessionsSendAdapter(enabledConfig)).toBe(true);
    expect(shouldUseStandaloneBrokerSessionsSendAdapter(disabledConfig)).toBe(false);
  });

  it("resolves plugin-owned broker client config without core type imports", () => {
    expect(
      resolveA2ABrokerAdapterPluginConfig({
        plugins: {
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: " https://broker.example.com/adapter ",
                edgeSecret: " edge-secret ",
                requester: {
                  id: " hub-a ",
                  kind: "service",
                  role: "hub",
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      enabled: true,
      explicitlyActivated: true,
      baseUrl: "https://broker.example.com/adapter",
      edgeSecret: "edge-secret",
      requester: {
        id: "hub-a",
        kind: "service",
        role: "hub",
      },
    });
  });

  it("creates a broker client from the plugin-owned seam once activation and baseUrl are present", () => {
    const createClient = vi.fn().mockReturnValue({ kind: "broker-client" });

    const client = createConfiguredA2ABrokerClient(
      {
        plugins: {
          entries: {
            [A2A_BROKER_ADAPTER_PLUGIN_ID]: {
              enabled: true,
              config: {
                baseUrl: "https://broker.example.com",
                edgeSecret: "edge-secret",
                requester: {
                  id: "hub-a",
                  kind: "service",
                  role: "hub",
                },
              },
            },
          },
        },
      },
      { createClient },
    );

    expect(createClient).toHaveBeenCalledWith({
      baseUrl: "https://broker.example.com",
      edgeSecret: "edge-secret",
      requester: {
        id: "hub-a",
        kind: "service",
        role: "hub",
      },
    });
    expect(client).toEqual({ kind: "broker-client" });
  });
});
