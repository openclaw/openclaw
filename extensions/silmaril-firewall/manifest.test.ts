import fs from "node:fs";
import { describe, expect, it } from "vitest";

type SilmarilFirewallPackageManifest = {
  dependencies?: Record<string, string>;
  openclaw?: {
    bundle?: {
      stageRuntimeDependencies?: boolean;
    };
  };
};

type SilmarilFirewallPluginManifest = {
  contracts?: {
    agentToolResultMiddleware?: string[];
  };
};

describe("silmaril-firewall package manifest", () => {
  it("stages the Silmaril SDK as a bundled runtime dependency", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as SilmarilFirewallPackageManifest;

    expect(packageJson.dependencies?.["@silmaril-security/sdk"]).toBe("0.4.2");
    expect(packageJson.openclaw?.bundle?.stageRuntimeDependencies).toBe(true);
  });

  it("declares runtime-neutral tool result middleware ownership in the manifest contract", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as SilmarilFirewallPluginManifest;

    expect(manifest.contracts?.agentToolResultMiddleware).toEqual(["pi", "codex"]);
  });
});
