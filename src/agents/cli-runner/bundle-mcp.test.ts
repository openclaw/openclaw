/** Tests Claude-style bundle-MCP config-file overlays for CLI backends. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeClaudeBundleManifest } from "../../plugins/bundle-mcp.test-support.js";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  prepareBundleProbeCliConfig,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig", () => {
  it("injects a strict empty --mcp-config overlay for bundle-MCP-enabled backends without servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-empty-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    // Even empty overlays force Claude to ignore user/global MCP servers.
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toStrictEqual({});

    await prepared.cleanup?.();
  });

  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
    const prepared = await prepareBundleProbeCliConfig();

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    const bundleProbeArg = raw.mcpServers?.bundleProbe?.args?.[0];
    expect(bundleProbeArg).toBeDefined();
    expect(await fs.realpath(bundleProbeArg!)).toEqual(
      await fs.realpath(cliBundleMcpHarness.bundleProbeServerPath),
    );
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.mcpResumeHash).toMatch(/^[0-9a-f]{64}$/);

    await prepared.cleanup?.();
  });

  it("loads workspace bundle MCP plugins from the configured workspace root", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-workspace-root-",
    );
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-probe");
    // Workspace-local plugins should be resolved relative to workspaceDir, not HOME.
    const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
    await fs.mkdir(path.dirname(serverPath), { recursive: true });
    await fs.writeFile(serverPath, "export {};\n", "utf-8");
    await writeClaudeBundleManifest({
      homeDir: workspaceDir,
      pluginId: "workspace-probe",
      manifest: { name: "workspace-probe" },
    });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            workspaceProbe: {
              command: "node",
              args: ["./servers/probe.mjs"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: {
        plugins: {
          entries: {
            "workspace-probe": { enabled: true },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    const workspaceProbeArg = raw.mcpServers?.workspaceProbe?.args?.[0];
    expect(workspaceProbeArg).toBeDefined();
    expect(await fs.realpath(workspaceProbeArg!)).toEqual(
      await fs.realpath(serverPath),
    );

    await prepared.cleanup?.();
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const additionalConfig = {
      mcpServers: {
        openclaw: {
          type: "http",
          url: "http://127.0.0.1:23119/mcp",
          headers: {
            Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
          },
        },
      },
    };
    const prepared = await prepareBundleProbeCliConfig({
      additionalConfig,
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });
    const otherEnvPrepared = await prepareBundleProbeCliConfig({
      additionalConfig,
      env: {
        OPENCLAW_MCP_TOKEN: "other-loopback-token",
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer loopback-token-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-agent-id"]).toBeUndefined();
    await prepareCliBundleMcpCaptureAttempt({
      mode: "claude-config-file",
      backend: prepared.backend,
      env: prepared.env,
      captureKey: "attempt-123",
    });
    const attemptRaw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(attemptRaw.mcpServers?.openclaw?.headers?.Authorization).toBe(
      "Bearer loopback-token-123",
    );
    expect(attemptRaw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe(
      "attempt-123",
    );
    expect(prepared.mcpConfigHash).toBe(otherEnvPrepared.mcpConfigHash);
    expect(prepared.mcpResumeHash).toBe(otherEnvPrepared.mcpResumeHash);

    await prepared.cleanup?.();
    await otherEnvPrepared.cleanup?.();
  });

  it("merges caller context onto loopback HTTP MCP when the server sets injectCallerContext true", async () => {
    const prepared = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
            injectCallerContext: true,
          },
        },
      },
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-agent-id"]).toBe(
      "${OPENCLAW_MCP_AGENT_ID}",
    );

    await prepared.cleanup?.();
  });

  it("preserves extra env values alongside generated MCP config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-env-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
      },
    });

    expect(prepared.env).toEqual({
      OPENCLAW_MCP_TOKEN: "loopback-token-123",
      OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
    });

    await prepared.cleanup?.();
  });

  it("leaves args untouched when bundle MCP is disabled", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      backend: {
        command: "node",
        args: ["./fake-cli.mjs"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-disabled",
    });

    expect(prepared.backend.args).toEqual(["./fake-cli.mjs"]);
    expect(prepared.cleanup).toBeUndefined();
  });
});
