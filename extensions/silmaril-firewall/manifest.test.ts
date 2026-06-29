import fs from "node:fs";
import { describe, expect, it } from "vitest";

type SilmarilFirewallPackageManifest = {
  id?: string;
};

type SilmarilFirewallPluginManifest = {
  contracts?: {
    agentToolResultMiddleware?: string[];
  };
};

describe("silmaril-firewall manifest", () => {
  it("does not require a package manifest or runtime dependency graph changes", () => {
    expect(fs.existsSync(new URL("./package.json", import.meta.url))).toBe(false);

    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as SilmarilFirewallPackageManifest;

    expect(manifest.id).toBe("silmaril-firewall");
  });

  it("declares runtime-neutral tool result middleware ownership in the manifest contract", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as SilmarilFirewallPluginManifest;

    expect(manifest.contracts?.agentToolResultMiddleware).toEqual(["pi", "codex"]);
  });
});
