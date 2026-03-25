import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecRemoteCommand,
  buildOpenShellBaseArgv,
  resolveOpenShellCommand,
  setBundledOpenShellCommandResolverForTest,
  shellEscape,
} from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";

describe("openshell cli helpers", () => {
  afterEach(() => {
    setBundledOpenShellCommandResolverForTest();
  });

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

  it("prefers the bundled openshell command when available", () => {
    setBundledOpenShellCommandResolverForTest(() => "/tmp/node_modules/.bin/openshell");
    const config = resolveOpenShellPluginConfig(undefined);

    expect(resolveOpenShellCommand("openshell")).toBe("/tmp/node_modules/.bin/openshell");
    expect(buildOpenShellBaseArgv(config)).toEqual(["/tmp/node_modules/.bin/openshell"]);
  });

  it("falls back to the PATH command when no bundled openshell is present", () => {
    setBundledOpenShellCommandResolverForTest(() => null);

    expect(resolveOpenShellCommand("openshell")).toBe("openshell");
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
