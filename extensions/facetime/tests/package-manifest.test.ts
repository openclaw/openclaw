import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("published plugin manifest", () => {
  it("declares an external experimental plugin and leaves the helper port dynamic", () => {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const pluginManifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );

    expect(packageManifest.openclaw.extensions).toEqual(["./index.ts"]);
    expect(packageManifest.openclaw.runtimeExtensions).toBeUndefined();
    expect(packageManifest.license).toBe("MIT");
    expect(packageManifest.author).toBe("OpenClaw contributors");
    expect(packageManifest.homepage).toBe("https://docs.openclaw.ai/plugins/facetime");
    expect(packageManifest.bugs.url).toBe("https://github.com/openclaw/openclaw/issues");
    expect(packageManifest.repository).toEqual({
      type: "git",
      url: "https://github.com/openclaw/openclaw",
      directory: "extensions/facetime",
    });
    expect(packageManifest.os).toEqual(["darwin"]);
    expect(packageManifest.cpu).toEqual(["arm64"]);
    expect(packageManifest.files).toContain("dist/");
    expect(packageManifest.files).not.toContain("doctor-contract-api.ts");
    expect(packageManifest.files).toContain("LICENSE");
    expect(packageManifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(packageManifest.files).toContain("skills/");
    expect(packageManifest.devDependencies.openclaw).toBe("workspace:*");
    expect(packageManifest.peerDependencies.openclaw).toBe(">=2026.7.2-beta.8");
    expect(packageManifest.openclaw.install.minHostVersion).toBe(">=2026.7.2-beta.8");
    expect(packageManifest.openclaw.compat.pluginApi).toBe(">=2026.7.2-beta.8");
    expect(packageManifest.openclaw.build).toEqual({
      bundledDist: false,
      openclawVersion: "2026.7.2",
    });
    expect(packageManifest.openclaw.release).toEqual({
      publishToClawHub: true,
      publishToNpm: true,
    });
    expect(pluginManifest.enabledByDefault).toBe(false);
    expect(pluginManifest.skills).toEqual(["./skills"]);
    expect(pluginManifest.contracts.tools).toEqual(["facetime_call"]);
    expect(pluginManifest.configSchema.properties.helperPort).toEqual({ type: "number" });
  });
});
