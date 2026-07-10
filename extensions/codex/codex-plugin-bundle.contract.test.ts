import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = import.meta.dirname;
const repoRoot = path.resolve(packageRoot, "../..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

function readRepoJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Codex plugin bundle contract", () => {
  it("keeps the native OpenClaw and Codex manifests side by side", () => {
    const nativeManifest = readJson("openclaw.plugin.json");
    const codexManifest = readJson(".codex-plugin/plugin.json");
    const packageJson = readJson("package.json");

    expect(nativeManifest.id).toBe("codex");
    expect(codexManifest).toMatchObject({
      name: path.basename(packageRoot),
      version: packageJson.version,
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "OpenClaw",
        composerIcon: "./assets/openclaw-outline.svg",
        logo: "./assets/openclaw-outline.svg",
      },
    });
  });

  it("starts the installed OpenClaw MCP bridge with an explicit app resource", () => {
    expect(readJson(".mcp.json")).toEqual({
      mcpServers: {
        openclaw: {
          type: "stdio",
          command: "openclaw",
          args: [
            "mcp",
            "serve",
            "--client",
            "codex",
            "--app-resource",
            "assets/openclaw-session-app.html",
          ],
          cwd: ".",
        },
      },
    });
  });

  it("is installable from the OpenClaw repository marketplace", () => {
    const codexManifest = readJson(".codex-plugin/plugin.json");
    const marketplace = readRepoJson(".agents/plugins/marketplace.json");

    expect(marketplace).toMatchObject({
      name: "openclaw",
      interface: { displayName: "OpenClaw" },
      plugins: [
        {
          name: codexManifest.name,
          source: {
            source: "git-subdir",
            url: "openclaw/openclaw",
            path: "extensions/codex",
            ref: "main",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          interface: { displayName: "OpenClaw" },
        },
      ],
    });
  });

  it("keeps the native runtime and Codex bundle in the npm artifact", () => {
    const packageJson = readJson("package.json");

    expect(packageJson.files).toBeUndefined();
    for (const relativePath of [
      "index.ts",
      "openclaw.plugin.json",
      "src/app-server/client.ts",
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "assets/openclaw-outline.svg",
      "assets/openclaw-outline-light.svg",
      "assets/openclaw-outline-dark.svg",
      "assets/openclaw-session-app.html",
    ]) {
      expect(fs.existsSync(path.join(packageRoot, relativePath)), relativePath).toBe(true);
    }
  });

  it("ships a self-contained session app using the stable tool contract", () => {
    const html = fs.readFileSync(
      path.join(packageRoot, "assets/openclaw-session-app.html"),
      "utf8",
    );

    expect(html).not.toMatch(/<(?:link|script)\b[^>]+(?:href|src)=/u);
    expect(html).toContain('const UI_PROTOCOL_VERSION = "2026-01-26"');
    expect(html).toContain('"openclaw_sessions_list"');
    expect(html).toContain('"openclaw_session_detail"');
    expect(html).toContain('"openclaw_session_create"');
    expect(html).toContain('"openclaw_session_send"');
    expect(html).toContain('"openclaw_session_abort"');
    expect(html).toContain('"openclaw_session_update"');
    expect(html).toContain("Array.isArray(item.icons)");
    expect(html).toContain('searchParams.get("fixture")');
  });
});
