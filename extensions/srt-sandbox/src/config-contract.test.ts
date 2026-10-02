import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSrtPluginConfig } from "./config.js";
import { buildSrtRuntimeConfig, resolveWritableRoots } from "./srt-runtime-config.js";
import { buildWindowsExecSpec } from "./windows-sandbox-config.js";

const scope = {
  workspaceDir: "/workspace",
  agentWorkspaceDir: "/agent",
  workspaceAccess: "rw" as const,
};

describe("SRT configuration contract", () => {
  it("preserves Windows drive and UNC writable roots", () => {
    expect(
      resolveWritableRoots(
        { ...scope, workspaceDir: "C:\\workspace", agentWorkspaceDir: "\\\\server\\agent" },
        ["D:\\scratch", "\\\\server\\share"],
      ),
    ).toEqual(["C:\\workspace", "\\\\server\\agent", "D:\\scratch", "\\\\server\\share"]);
  });

  it("emits executable deny, allowlist, and open network semantics", async () => {
    const deny = buildSrtRuntimeConfig(scope, resolveSrtPluginConfig({ network: "deny" }));
    expect(deny.network).toMatchObject({
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
    });
    const allowlist = buildSrtRuntimeConfig(
      scope,
      resolveSrtPluginConfig({ network: "deny", allowedDomains: ["example.com"] }),
    );
    expect(allowlist.network).toMatchObject({
      allowedDomains: ["example.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });
    const open = buildSrtRuntimeConfig(scope, resolveSrtPluginConfig({ network: "allow" }));
    expect(await open.network.filterRequest?.({} as never)).toEqual({ action: "allow" });
  });

  it("keeps runtime and published manifest keys aligned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: { properties: Record<string, unknown> };
      uiHints: Record<string, unknown>;
    };
    for (const key of ["allowedDomains", "perSessionNetwork", "parentProxy", "windows"]) {
      expect(manifest.configSchema.properties).toHaveProperty(key);
      expect(manifest.uiHints).toHaveProperty(key);
    }
    expect(() =>
      resolveSrtPluginConfig({
        writablePaths: ["C:\\workspace", "\\\\server\\share"],
        windows: { srtWinPath: "C:\\tools\\srt-win.exe" },
      }),
    ).not.toThrow();
  });

  it("preserves requested Windows environment and rejects unsupported account switching", () => {
    const spec = buildWindowsExecSpec({
      command: "echo %TOKEN%",
      cwd: "C:\\workspace",
      allowWrite: ["C:\\workspace"],
      sandboxUser: "srt-sandbox",
      setEnvVars: { TOKEN: "scope-value" },
      srtWin: { exe: "C:\\tools\\srt-win.exe", prependArgs: [] },
    });
    expect(spec.argv).toContain("TOKEN=scope-value");
    expect(() =>
      buildWindowsExecSpec({
        command: "whoami",
        cwd: "C:\\workspace",
        allowWrite: [],
        sandboxUser: "srt-other",
        srtWin: { exe: "C:\\tools\\srt-win.exe", prependArgs: [] },
      }),
    ).toThrow(/account pools are unsupported/);
  });
});
