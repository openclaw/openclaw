import { describe, expect, it } from "vitest";
import { isGatewayRestartCliCommand } from "./bash-tools.exec.js";

describe("isGatewayRestartCliCommand", () => {
  it("matches plain gateway restart commands", () => {
    expect(isGatewayRestartCliCommand("openclaw gateway restart")).toBe(true);
    expect(isGatewayRestartCliCommand("openclaw gateway restart --json")).toBe(true);
    expect(isGatewayRestartCliCommand("/usr/local/bin/openclaw gateway restart")).toBe(true);
  });

  it("supports leading env assignments", () => {
    expect(
      isGatewayRestartCliCommand(
        "OPENCLAW_HOME=/tmp/home OPENCLAW_ENV=prod openclaw gateway restart",
      ),
    ).toBe(true);
  });

  it("rejects non-restart or non-cli commands", () => {
    expect(isGatewayRestartCliCommand("openclaw gateway status")).toBe(false);
    expect(isGatewayRestartCliCommand("echo openclaw gateway restart")).toBe(false);
    expect(isGatewayRestartCliCommand("openclaw gateway restart && echo done")).toBe(false);
    expect(isGatewayRestartCliCommand("")).toBe(false);
  });
});
