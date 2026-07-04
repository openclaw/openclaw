/** Tests merging user OpenClaw MCP server config into Claude bundle-MCP overlays. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeClaudeBundleManifest } from "../../plugins/bundle-mcp.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig user mcp.servers", () => {
  const liveBackend = {
    command: "node",
    args: ["./fake-claude.mjs"],
    liveSession: "claude-stdio" as const,
    output: "jsonl" as const,
    input: "stdin" as const,
  };

  it("merges user-configured mcp.servers from OpenClaw config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: liveBackend,
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            omi: {
              type: "sse",
              url: "https://api.omi.me/v1/mcp/sse",
              headers: { Authorization: "Bearer test-token" },
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    expect(raw.mcpServers?.omi?.type).toBe("sse");
    expect(raw.mcpServers?.omi?.url).toBe("https://api.omi.me/v1/mcp/sse");

    await prepared.cleanup?.();
  });

  it("translates OpenClaw transport field on user mcp.servers into Claude type", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-transport-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: liveBackend,
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            context7: {
              transport: "streamable-http",
              url: "https://mcp.context7.com/mcp",
              headers: { CONTEXT7_API_KEY: "ctx7sk-test" },
            },
            "omi-sse": {
              transport: "sse",
              url: "https://api.omi.me/v1/mcp/sse",
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; transport?: string; url?: string }>;
    };

    expect(raw.mcpServers?.context7?.type).toBe("http");
    expect(raw.mcpServers?.context7?.url).toBe("https://mcp.context7.com/mcp");
    expect(raw.mcpServers?.context7?.transport).toBeUndefined();

    expect(raw.mcpServers?.["omi-sse"]?.type).toBe("sse");
    expect(raw.mcpServers?.["omi-sse"]?.transport).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("keeps MCP tool filters in runtime policy metadata instead of Claude config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-tool-filter-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: liveBackend,
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            "computer-use": {
              command: "/Applications/Codex.app/Contents/Resources/computer-use",
              args: ["mcp"],
              toolFilter: {
                include: ["list_apps", "observe", "click"],
                exclude: ["click"],
              },
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { toolFilter?: unknown }>;
    };
    expect(raw.mcpServers?.["computer-use"]).toBeUndefined();
    expect(raw.mcpServers?.["openclaw-mcp-computer-use"]?.toolFilter).toBeUndefined();
    expect(prepared.mcpServerToolPolicies).toEqual({
      "openclaw-mcp-computer-use": {
        configuredName: "computer-use",
        safeName: "computer-use",
        include: ["list_apps", "observe", "click"],
        exclude: ["click"],
      },
    });

    await prepared.cleanup?.();
  });

  it("avoids collisions when aliasing Claude's reserved computer-use server name", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-reserved-name-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: liveBackend,
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            "computer-use": { command: "cua-driver", args: ["mcp"] },
            "openclaw-mcp-computer-use": { command: "other-driver" },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(raw.mcpServers?.["openclaw-mcp-computer-use"]?.command).toBe("other-driver");
    expect(raw.mcpServers?.["openclaw-mcp-computer-use-2"]?.command).toBe("cua-driver");
    expect(prepared.mcpServerToolPolicies?.["openclaw-mcp-computer-use-2"]).toMatchObject({
      configuredName: "computer-use",
      safeName: "computer-use",
    });

    await prepared.cleanup?.();
  });

  it("keeps safe aliases in managed source order after overriding native entries", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-managed-alias-order-",
    );
    const nativeConfigPath = path.join(workspaceDir, "native-mcp.json");
    await fs.writeFile(
      nativeConfigPath,
      `${JSON.stringify({
        mcpServers: {
          "foo:bar": { command: "native-driver" },
        },
      })}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        ...liveBackend,
        args: ["./fake-claude.mjs", "--mcp-config", nativeConfigPath],
      },
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            "foo-bar": { command: "dash-driver" },
            "foo:bar": { command: "colon-driver" },
          },
        },
      },
    });

    expect(prepared.mcpServerToolPolicies?.["foo-bar"]).toMatchObject({
      configuredName: "foo-bar",
      safeName: "foo-bar",
    });
    expect(prepared.mcpServerToolPolicies?.["foo:bar"]).toMatchObject({
      configuredName: "foo:bar",
      safeName: "foo-bar-2",
    });

    await prepared.cleanup?.();
  });

  it("preserves explicit type and still strips transport on user mcp.servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-transport-explicit-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: liveBackend,
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            mixed: {
              type: "http",
              transport: "sse",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; transport?: string }>;
    };

    expect(raw.mcpServers?.mixed?.type).toBe("http");
    expect(raw.mcpServers?.mixed?.transport).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("user mcp.servers do not override the loopback additionalConfig", async () => {
    // The OpenClaw loopback server is generated runtime state and must win over
    // user config with the same server name.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-loopback-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: liveBackend,
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            openclaw: {
              command: "untrusted-openclaw-server",
              args: ["mcp"],
              env: { UNTRUSTED: "true" },
              type: "http",
              url: "https://example.com/malicious",
            },
          },
        },
      },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<
        string,
        {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          headers?: Record<string, string>;
        }
      >;
    };
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.command).toBeUndefined();
    expect(raw.mcpServers?.openclaw?.args).toBeUndefined();
    expect(raw.mcpServers?.openclaw?.env).toBeUndefined();
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-direct-mcp-servers"]).toBe("true");

    await prepared.cleanup?.();
  });

  it("replaces overlapping bundle server entries with user-configured mcp.servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-replace-",
    );
    await writeClaudeBundleManifest({
      homeDir: cliBundleMcpHarness.bundleProbeHomeDir,
      pluginId: "omi",
      manifest: { name: "omi" },
    });
    const pluginDir = path.join(
      cliBundleMcpHarness.bundleProbeHomeDir,
      ".openclaw",
      "extensions",
      "omi",
    );
    await fs.writeFile(
      path.join(pluginDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            omi: {
              command: process.execPath,
              args: [cliBundleMcpHarness.bundleProbeServerPath],
              env: { BUNDLE_ONLY: "true" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await withEnvAsync({ HOME: cliBundleMcpHarness.bundleProbeHomeDir }, async () => {
      const prepared = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: liveBackend,
        workspaceDir,
        config: {
          plugins: {
            entries: {
              omi: { enabled: true },
            },
          },
          mcp: {
            servers: {
              omi: {
                type: "sse",
                url: "https://api.omi.me/v1/mcp/sse",
                headers: { Authorization: "Bearer test-token" },
              },
            },
          },
        },
      });

      const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
      const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
        mcpServers?: Record<
          string,
          {
            type?: string;
            url?: string;
            command?: string;
            args?: string[];
            env?: Record<string, string>;
          }
        >;
      };
      expect(raw.mcpServers?.omi?.type).toBe("sse");
      expect(raw.mcpServers?.omi?.url).toBe("https://api.omi.me/v1/mcp/sse");
      expect(raw.mcpServers?.omi?.command).toBeUndefined();
      expect(raw.mcpServers?.omi?.args).toBeUndefined();
      expect(raw.mcpServers?.omi?.env).toBeUndefined();

      await prepared.cleanup?.();
    });
  });

  it("fails closed when external MCP is configured without Claude live policy enforcement", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-non-live-",
    );

    await expect(
      prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: {
          command: "node",
          args: ["./fake-claude.mjs"],
          output: "text",
          input: "arg",
        },
        workspaceDir,
        config: {
          plugins: { enabled: false },
          mcp: {
            servers: {
              external: { command: "external-mcp" },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'Claude CLI external MCP servers require liveSession: "claude-stdio", output: "jsonl", resumeOutput unset or "jsonl", and input: "stdin" for OpenClaw tool policy enforcement',
    );
  });

  it("fails closed when a Claude live-session override changes the transport contract", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-invalid-live-transport-",
    );

    await expect(
      prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: {
          ...liveBackend,
          output: "text",
        },
        workspaceDir,
        config: {
          plugins: { enabled: false },
          mcp: {
            servers: {
              external: { command: "external-mcp" },
            },
          },
        },
      }),
    ).rejects.toThrow('output: "jsonl"');
  });

  it("fails closed when Claude resume output leaves the live JSONL contract", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-invalid-live-resume-output-",
    );

    await expect(
      prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: {
          ...liveBackend,
          resumeOutput: "text",
        },
        workspaceDir,
        config: {
          plugins: { enabled: false },
          mcp: {
            servers: {
              external: { command: "external-mcp" },
            },
          },
        },
      }),
    ).rejects.toThrow('output: "jsonl"');
  });
});
