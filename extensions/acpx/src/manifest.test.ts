// ACPX tests cover manifest plugin behavior.
import fs from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { AcpxPluginConfigSchema } from "./config-schema.js";

type AcpxPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  openclaw?: {
    install?: {
      requiredPlatformPackages?: string[];
    };
  };
};

type AcpxPluginManifest = {
  backupResources?: Array<{
    disposition: string;
    scope: string;
    relativePath: string;
  }>;
  configGroups?: Array<{
    id: string;
    properties: string[];
  }>;
  configSchema?: {
    properties?: Record<string, Record<string, unknown>>;
  };
  uiHints?: Record<string, Record<string, unknown>>;
};

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as AcpxPackageManifest;

const pluginJson = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as AcpxPluginManifest;

describe("acpx package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    expect(packageJson.dependencies?.acpx).toBeTypeOf("string");
    expect(packageJson.dependencies?.acpx).not.toBe("");
    expect(packageJson.dependencies?.["@agentclientprotocol/codex-acp"]).toBe("2.3.0");
    expect(packageJson.dependencies?.["@zed-industries/codex-acp"]).toBeUndefined();
    expect(packageJson.dependencies?.["@agentclientprotocol/claude-agent-acp"]).toBe("0.99.1");
    expect(packageJson.devDependencies?.["@agentclientprotocol/claude-agent-acp"]).toBeUndefined();
  });

  it("declares the transitive native platform packages required by ACP adapters", () => {
    expect(packageJson.openclaw?.install?.requiredPlatformPackages).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64",
      "@anthropic-ai/claude-agent-sdk-linux-arm64",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "@anthropic-ai/claude-agent-sdk-win32-x64",
      "@anthropic-ai/claude-agent-sdk-win32-arm64",
      "@openai/codex-linux-x64",
      "@openai/codex-linux-arm64",
      "@openai/codex-darwin-x64",
      "@openai/codex-darwin-arm64",
      "@openai/codex-win32-x64",
      "@openai/codex-win32-arm64",
    ]);
  });

  it("declares ACPX-written codex-home scratch state as regenerable backup resources", () => {
    expect(pluginJson.backupResources).toStrictEqual([
      {
        disposition: "regenerable",
        scope: "state",
        relativePath: "acpx/codex-home/tmp/arg0",
      },
      {
        disposition: "regenerable",
        scope: "state",
        relativePath: "acpx/codex-home/.tmp/plugins",
      },
    ]);
  });

  it("declares pluginToolsMcpBridgeAllow and pluginToolsMcpBridgeDeny in schema, groups, and uiHints with Zod parity", () => {
    const toolsGroup = pluginJson.configGroups?.find(
      (group) => group.id === "tools-and-mcp-servers",
    );
    expect(toolsGroup?.properties).toEqual(
      expect.arrayContaining(["pluginToolsMcpBridgeAllow", "pluginToolsMcpBridgeDeny"]),
    );
    expect(pluginJson.uiHints?.pluginToolsMcpBridgeAllow).toBeDefined();
    expect(pluginJson.uiHints?.pluginToolsMcpBridgeDeny).toBeDefined();

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validateManifest = ajv.compile(pluginJson.configSchema ?? {});
    const fixtures: Array<[Record<string, unknown>, boolean]> = [
      [{ pluginToolsMcpBridgeAllow: ["memory-core", "github"] }, true],
      [{ pluginToolsMcpBridgeDeny: [] }, true],
      [{ pluginToolsMcpBridgeDeny: ["diffs"] }, true],
      [{ pluginToolsMcpBridgeAllow: [] }, false],
      [{ pluginToolsMcpBridgeAllow: [""] }, false],
      [{ pluginToolsMcpBridgeAllow: ["   "] }, false],
      [{ pluginToolsMcpBridgeAllow: "memory-core" }, false],
      [{ pluginToolsMcpBridgeDeny: [""] }, false],
      [{ pluginToolsMcpBridgeDeny: [" \t "] }, false],
      [{ pluginToolsMcpBridgeDeny: [42] }, false],
    ];
    for (const [fixture, expectedValid] of fixtures) {
      expect(validateManifest(fixture)).toBe(expectedValid);
      expect(AcpxPluginConfigSchema.safeParse(fixture).success).toBe(expectedValid);
    }
  });
});
