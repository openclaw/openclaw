import fs from "node:fs";
import { describe, expect, it } from "vitest";

type SilmarilFirewallPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
};

type SilmarilFirewallPluginManifest = {
  contracts?: {
    agentToolResultMiddleware?: string[];
  };
};

describe("silmaril-firewall manifest", () => {
  it("keeps the package manifest runtime-neutral", () => {
    expect(fs.existsSync(new URL("./package.json", import.meta.url))).toBe(true);

    const packageManifest = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as SilmarilFirewallPackageManifest;

    expect(packageManifest.name).toBe("@openclaw/silmaril-firewall");
    expect(packageManifest.dependencies).toBeUndefined();
    expect(packageManifest.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
  });

  it("declares runtime-neutral tool result middleware ownership in the manifest contract", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as SilmarilFirewallPluginManifest;

    expect(manifest.contracts?.agentToolResultMiddleware).toEqual(["pi", "codex"]);
  });
});
