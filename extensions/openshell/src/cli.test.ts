import { describe, expect, it } from "vitest";
import { buildExecRemoteCommand, buildOpenShellBaseArgv, shellEscape } from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";

describe("openshell cli helpers", () => {
  it("builds base argv with gateway overrides", () => {
    const config = resolveOpenShellPluginConfig({
      command: "/usr/local/bin/openshell",
      gateway: "lab",
      gatewayEndpoint: "https://lab.example",
    });
    expect(buildOpenShellBaseArgv(config)).toEqual([
      "/usr/local/bin/openshell",
      "--gateway",
      "lab",
      "--gateway-endpoint",
      "https://lab.example",
    ]);
  });

  it("shell escapes single quotes", () => {
    expect(shellEscape(`a'b`)).toBe(`'a'"'"'b'`);
  });

  it("wraps exec commands with env and workdir", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      workdir: "/sandbox/project",
      env: {
        TOKEN: "abc 123",
      },
    });
    expect(command).toContain(`'env'`);
    expect(command).toContain(`'TOKEN=abc 123'`);
    expect(command).toContain(`'cd '"'"'/sandbox/project'"'"' && pwd && printenv TOKEN'`);
  });
});
