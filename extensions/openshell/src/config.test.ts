import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenShellPluginConfigSchema, resolveOpenShellPluginConfig } from "./config.js";
import { createWorkerFixture } from "./worker.test-support.js";

const parse = (config: unknown) => createOpenShellPluginConfigSchema().safeParse?.(config).success;
const resolveWorkspace = (remoteRoot: string) =>
  resolveOpenShellPluginConfig({
    worker: createWorkerFixture({ agentId: "main", remoteRoot }),
  });

describe("openshell plugin config", () => {
  it("applies defaults", () => {
    expect(resolveOpenShellPluginConfig(undefined)).toEqual({
      mode: "mirror",
      command: "openshell",
      gateway: undefined,
      gatewayEndpoint: undefined,
      workspace: undefined,
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

  it.each([
    ["sandbox", "must be absolute"],
    ["/tmp/victim", "must stay under /sandbox or /agent"],
  ])("rejects unmanaged remote path %s", (remoteWorkspaceDir, message) => {
    const config = { remoteWorkspaceDir };
    expect(parse(config)).toBe(false);
    expect(() => resolveOpenShellPluginConfig(config)).toThrow(
      `OpenShell remoteWorkspaceDir ${message}`,
    );
  });

  it("rejects normalized paths that escape managed sandbox roots during config validation", () => {
    expect(parse({ remoteAgentWorkspaceDir: "/agent/../../etc" })).toBe(false);
  });

  it("preserves shipped equal workspace roots", () => {
    const config = {
      remoteWorkspaceDir: "/sandbox/project",
      remoteAgentWorkspaceDir: "/sandbox/project",
    };
    expect(parse(config)).toBe(true);
    expect(resolveOpenShellPluginConfig(config)).toMatchObject(config);
  });

  it("requires a literal, normalized private agent workspace root", () => {
    expect(resolveWorkspace("/agent/canonical").worker?.agentWorkspace?.remoteRoot).toBe(
      "/agent/canonical",
    );
    const rejectedRoots =
      "/agent /sandbox /etc/private /agent/a/../b /agent/* /agent/[ab] /agent/{a,b} /agent/!(private) /agent/a\\b";
    for (const root of rejectedRoots.split(" ")) {
      expect(() => resolveWorkspace(root)).toThrow();
    }
  });

  it("rejects timeouts beyond Node's safe timer range", () => {
    expect(() => resolveOpenShellPluginConfig({ timeoutSeconds: 2_147_001 })).toThrow(
      "timeoutSeconds must be a number <= 2147000",
    );
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(createOpenShellPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});
