import { describe, expect, it } from "vitest";
import { resolveOpenShellPluginConfig } from "./config.js";

describe("openshell plugin config", () => {
  it("applies defaults", () => {
    expect(resolveOpenShellPluginConfig(undefined)).toEqual({
      command: "openshell",
      gateway: undefined,
      gatewayEndpoint: undefined,
      from: "openclaw",
      policy: undefined,
      providers: [],
      gpu: false,
      autoProviders: true,
      remoteWorkspaceDir: "/sandbox",
      remoteAgentWorkspaceDir: "/agent",
      timeoutMs: 120_000,
    });
  });

  it("rejects relative remote paths", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        remoteWorkspaceDir: "sandbox",
      }),
    ).toThrow("OpenShell remote path must be absolute");
  });
});
