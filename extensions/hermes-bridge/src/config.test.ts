import { describe, expect, it } from "vitest";
import { DEFAULT_HERMES_BRIDGE_CONFIG, resolveHermesBridgeConfig } from "./config.js";

describe("resolveHermesBridgeConfig", () => {
  it("defaults to disabled mock mode", () => {
    expect(resolveHermesBridgeConfig(undefined)).toEqual(DEFAULT_HERMES_BRIDGE_CONFIG);
  });

  it("normalizes supported config values", () => {
    expect(
      resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        hermesAgentPath: " ../hermes-agent ",
        sharedSecretEnv: " HERMES_TOKEN ",
        allowedTasks: ["status.echo", "status.echo", " message.preview ", "", 42],
        allowedTools: ["telegram.send", "telegram.send", " shell ", "", false],
        maxRequestBytes: 128,
      }),
    ).toEqual({
      enabled: true,
      mode: "live",
      hermesMode: "real",
      hermesAgentPath: "../hermes-agent",
      sharedSecretEnv: "HERMES_TOKEN",
      allowedTasks: ["status.echo", "message.preview"],
      allowedTools: ["telegram.send", "shell"],
      maxRequestBytes: 128,
    });
  });
});
