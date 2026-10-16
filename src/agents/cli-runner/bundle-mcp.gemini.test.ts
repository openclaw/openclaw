/** Tests Gemini CLI bundle-MCP system settings generation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  setupCliBundleMcpTestHarness,
  writeCliMcpPolicyProbeServer,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

type PrepareParams = Parameters<typeof prepareCliBundleMcpConfig>[0];
function prepareGemini(params: Partial<PrepareParams> = {}) {
  return prepareCliBundleMcpConfig({
    enabled: true,
    mode: "gemini-system-settings",
    backend: { command: "gemini", args: ["--prompt", "{prompt}"] },
    workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
    ...params,
  });
}

function loopback(options: { headers?: Record<string, string>; excludeTools?: string[] } = {}) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: "http://127.0.0.1:23119/mcp",
        ...options,
      },
    },
  };
}

async function readSettings(prepared: Awaited<ReturnType<typeof prepareGemini>>) {
  return JSON.parse(
    await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
  ) as {
    mcp?: { allowed?: string[] };
    tools?: { exclude?: string[] };
    mcpServers?: Record<
      string,
      {
        url?: string;
        headers?: Record<string, string>;
        includeTools?: string[];
        excludeTools?: string[];
      }
    >;
    security?: { auth?: { selectedType?: string }; folderTrust?: { enabled?: boolean } };
  };
}

describe("prepareCliBundleMcpConfig gemini", () => {
  it("disables Gemini native web search without bundle MCP", async () => {
    const prepared = await prepareGemini({
      enabled: false,
      backend: { command: "gemini" },
      workspaceDir: "/tmp/openclaw-cli-gemini-web-search-disabled",
      toolOverrides: { webSearch: false },
    });
    const raw = await readSettings(prepared);

    expect(raw.tools?.exclude).toEqual(["google_web_search"]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    await prepared.cleanup?.();
  });

  it("writes Gemini system settings for bundle MCP servers", async () => {
    const prepared = await prepareGemini({
      config: { plugins: { enabled: false } },
      additionalConfig: loopback({
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-openclaw-client-caps": "${OPENCLAW_MCP_CLIENT_CAPS}",
        },
        excludeTools: ["global_delete"],
      }),
      env: {
        OPENCLAW_MCP_TOKEN: "lb-tk-123",
        OPENCLAW_MCP_CLIENT_CAPS: "tool-events,inline-widgets",
      },
      toolOverrides: { mcpToolsDeny: { openclaw: ["delete_docs"] }, webSearch: false },
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("lb-tk-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    const raw = await readSettings(prepared);
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw).toMatchObject({
      url: "http://127.0.0.1:23119/mcp",
      headers: {
        Authorization: "Bearer lb-tk-123",
        "x-openclaw-client-caps": "tool-events,inline-widgets",
      },
      excludeTools: ["delete_docs", "global_delete"],
    });
    expect(raw.tools?.exclude).toEqual(["google_web_search"]);

    await prepared.cleanup?.();
  });

  it("projects canonical allow and deny sets into Gemini settings", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["docs__read_docs"], deny: ["docs__delete_docs"] },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareGemini({
      backend: { command: "gemini" },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "gemini-policy"),
    });
    const raw = await readSettings(prepared);
    expect(raw.mcpServers?.docs).toMatchObject({
      includeTools: ["read_docs"],
      excludeTools: ["app_docs", "delete_docs", "task_docs"],
    });
    await prepared.cleanup?.();
  });

  it("omits a server when configured and policy allowlists do not overlap", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const prepared = await prepareGemini({
      backend: { command: "gemini" },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      exclusiveConfig: {
        mcpServers: {
          docs: {
            command: process.execPath,
            args: [serverPath],
            includeTools: ["legacy_only"],
            toolFilter: { include: ["read_docs"] },
          },
        },
      },
    });
    const raw = await readSettings(prepared);
    expect(raw.mcp?.allowed).not.toContain("docs");
    expect(raw.mcpServers?.docs).toBeUndefined();
    await prepared.cleanup?.();
  });

  it("writes a unique capture token into per-attempt Gemini settings", async () => {
    const prepared = await prepareGemini({
      config: { plugins: { enabled: false } },
      additionalConfig: loopback({
        headers: { "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}" },
      }),
      env: {
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });
    prepared.env = { ...prepared.env, GOOGLE_CLOUD_PROJECT: "active-capture-project" };
    const attempt = await prepareCliBundleMcpCaptureAttempt({
      preparedBackend: prepared,
      captureKey: "attempt-123",
    });

    try {
      const raw = await readSettings({ ...prepared, env: attempt.env });
      expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("attempt-123");
      expect(attempt.env?.GOOGLE_CLOUD_PROJECT).toBe("active-capture-project");
      expect(attempt.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).not.toBe(
        prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
      );
    } finally {
      await attempt.cleanup?.();
      await prepared.cleanup?.();
    }
  });

  it("preserves inherited Gemini auth selection in generated system settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-settings-"));
    const inheritedSettingsPath = path.join(dir, "settings.json");
    await fs.writeFile(
      inheritedSettingsPath,
      JSON.stringify({
        security: { auth: { selectedType: "vertex-ai" }, folderTrust: { enabled: true } },
      }),
      "utf-8",
    );
    const prepared = await prepareGemini({
      config: { plugins: { enabled: false } },
      additionalConfig: loopback(),
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath,
      },
    });

    try {
      const raw = await readSettings(prepared);
      expect(raw.security).toMatchObject({
        auth: { selectedType: "vertex-ai" },
        folderTrust: { enabled: true },
      });
      expect(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).not.toBe(inheritedSettingsPath);
    } finally {
      await prepared.cleanup?.();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
