import { describe, expect, it } from "vitest";
import { buildDerivedAppsConfig, resolveChatgptAppsConfig } from "./config.js";

describe("resolveChatgptAppsConfig", () => {
  it("defaults the feature off with the standard app-server command", () => {
    expect(resolveChatgptAppsConfig(undefined)).toEqual({
      enabled: false,
      chatgptBaseUrl: "https://chatgpt.com",
      appServer: {
        command: "codex",
        args: [],
      },
      linking: {
        enabled: false,
        waitTimeoutMs: 60_000,
        pollIntervalMs: 3_000,
      },
      connectors: {},
    });
  });

  it("normalizes app-server args and connector flags", () => {
    expect(
      resolveChatgptAppsConfig({
        chatgptApps: {
          enabled: true,
          chatgptBaseUrl: " https://chat.openai.com ",
          appServer: {
            command: " /usr/local/bin/codex ",
            args: ["app-server", "--analytics-default-enabled", "--verbose", "  ", "--foo"],
          },
          linking: {
            enabled: true,
            waitTimeoutMs: "45000",
            pollIntervalMs: 1500,
          },
          connectors: {
            gmail: { enabled: false },
            google_drive: {},
          },
        },
      }),
    ).toEqual({
      enabled: true,
      chatgptBaseUrl: "https://chat.openai.com",
      appServer: {
        command: "/usr/local/bin/codex",
        args: ["--verbose", "--foo"],
      },
      linking: {
        enabled: true,
        waitTimeoutMs: 45_000,
        pollIntervalMs: 1_500,
      },
      connectors: {
        gmail: { enabled: false },
        google_drive: { enabled: true },
      },
    });
  });
});

describe("buildDerivedAppsConfig", () => {
  it("owns the isolated Codex apps subtree from OpenClaw connector config", () => {
    expect(
      buildDerivedAppsConfig({
        enabled: true,
        chatgptBaseUrl: "https://chatgpt.com",
        appServer: {
          command: "codex",
          args: [],
        },
        linking: {
          enabled: false,
          waitTimeoutMs: 60_000,
          pollIntervalMs: 3_000,
        },
        connectors: {
          gmail: { enabled: false },
          google_drive: { enabled: true },
        },
      }),
    ).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      gmail: {
        enabled: false,
      },
      google_drive: {
        enabled: true,
      },
    });
  });
});
