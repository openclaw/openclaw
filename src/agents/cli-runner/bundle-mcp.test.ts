import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  writeClaudeBundleManifest,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

describe("prepareCliBundleMcpConfig", () => {
  it("injects a strict empty --mcp-config overlay for bundle-MCP-enabled backends without servers", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-empty-");

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: {},
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    expect(typeof generatedConfigPath).toBe("string");
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toEqual({});

    await prepared.cleanup?.();
  });

  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      const { serverPath } = await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const prepared = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: {
          command: "node",
          args: ["./fake-claude.mjs"],
        },
        workspaceDir,
        config,
      });

      const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
      expect(configFlagIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.backend.args).toContain("--strict-mcp-config");
      const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
      expect(typeof generatedConfigPath).toBe("string");
      const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
        mcpServers?: Record<string, { args?: string[] }>;
      };
      expect(raw.mcpServers?.bundleProbe?.args).toEqual([await fs.realpath(serverPath)]);
      expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);

      await prepared.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("loads workspace bundle MCP plugins from the configured workspace root", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-root-");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-probe");
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

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.workspaceProbe?.args).toEqual([await fs.realpath(serverPath)]);

    await prepared.cleanup?.();
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const prepared = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: {
          command: "node",
          args: ["./fake-claude.mjs"],
        },
        workspaceDir,
        config,
        additionalConfig: {
          mcpServers: {
            openclaw: {
              type: "http",
              url: "http://127.0.0.1:23119/mcp",
              headers: {
                Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              },
            },
          },
        },
      });

      const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
      const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
      const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
        mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
      };
      expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
      expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
      expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer ${OPENCLAW_MCP_TOKEN}");

      await prepared.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("keeps mcpConfigHash stable when only the loopback overlay port changes", async () => {
    // Regression: the loopback MCP bridge binds to an OS-assigned ephemeral port
    // on every gateway start. That port is embedded literally in the loopback
    // server URL and used to be part of the hashed `mergedConfig`, which caused
    // every persisted CLI session binding to be invalidated (`reason=mcp`) on
    // every restart and wiped the agent's conversation memory. The hash must be
    // computed from user-authored MCP state only.
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: { entries: { "bundle-probe": { enabled: true } } },
      };

      const makeLoopbackOverlay = (port: number) => ({
        mcpServers: {
          openclaw: {
            type: "http" as const,
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
          },
        },
      });

      const preparedFirst = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir,
        config,
        additionalConfig: makeLoopbackOverlay(62949),
      });
      const preparedSecond = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir,
        config,
        additionalConfig: makeLoopbackOverlay(51734),
      });

      expect(preparedFirst.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
      expect(preparedFirst.mcpConfigHash).toBe(preparedSecond.mcpConfigHash);

      // Written mcp.json must still reflect the *current* loopback port so the
      // CLI process can actually reach the bridge — only session identity is
      // port-agnostic.
      const firstCfgPath =
        preparedFirst.backend.args?.[
          (preparedFirst.backend.args?.indexOf("--mcp-config") ?? -1) + 1
        ];
      const secondCfgPath =
        preparedSecond.backend.args?.[
          (preparedSecond.backend.args?.indexOf("--mcp-config") ?? -1) + 1
        ];
      const firstRaw = JSON.parse(await fs.readFile(firstCfgPath as string, "utf-8")) as {
        mcpServers?: Record<string, { url?: string }>;
      };
      const secondRaw = JSON.parse(await fs.readFile(secondCfgPath as string, "utf-8")) as {
        mcpServers?: Record<string, { url?: string }>;
      };
      expect(firstRaw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:62949/mcp");
      expect(secondRaw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:51734/mcp");

      await preparedFirst.cleanup?.();
      await preparedSecond.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("changes mcpConfigHash when a real user-authored MCP server is added", async () => {
    // Guards against an over-broad fix: the hash must still invalidate the
    // stored session when the user actually adds/removes a plugin MCP server,
    // so the resumed Claude CLI sees the correct tool surface.
    const env = captureEnv(["HOME"]);
    try {
      const homeDirBefore = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-before-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDirBefore;

      const loopback = {
        mcpServers: {
          openclaw: {
            type: "http" as const,
            url: "http://127.0.0.1:23119/mcp",
            headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
          },
        },
      };

      const preparedEmpty = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir,
        config: {},
        additionalConfig: loopback,
      });

      const homeDirAfter = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-after-");
      process.env.HOME = homeDirAfter;
      await createBundleProbePlugin(homeDirAfter);

      const preparedWithPlugin = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir,
        config: { plugins: { entries: { "bundle-probe": { enabled: true } } } },
        additionalConfig: loopback,
      });

      expect(preparedEmpty.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
      expect(preparedWithPlugin.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
      expect(preparedEmpty.mcpConfigHash).not.toBe(preparedWithPlugin.mcpConfigHash);

      await preparedEmpty.cleanup?.();
      await preparedWithPlugin.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("changes mcpConfigHash when the loopback overlay disappears across runs", async () => {
    // `startGatewayEarlyRuntime` catches loopback startup failures and
    // continues, so `prepareCliBundleMcpConfig` can run with `additionalConfig`
    // on one gateway start and without it on the next. A session whose tool
    // surface included the `openclaw` bridge must not be silently resumed
    // against a run that no longer has the bridge — the hash must differ even
    // though we strip the ephemeral port.
    const workspaceDir = await tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-loopback-toggle-",
    );

    const loopback = {
      mcpServers: {
        openclaw: {
          type: "http" as const,
          url: "http://127.0.0.1:62949/mcp",
          headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
        },
      },
    };

    const preparedWithLoopback = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {},
      additionalConfig: loopback,
    });
    const preparedWithoutLoopback = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {},
    });

    expect(preparedWithLoopback.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preparedWithoutLoopback.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preparedWithLoopback.mcpConfigHash).not.toBe(preparedWithoutLoopback.mcpConfigHash);

    await preparedWithLoopback.cleanup?.();
    await preparedWithoutLoopback.cleanup?.();
  });

  it("exposes a legacyMcpConfigHash that matches what pre-fix gateway builds produced", async () => {
    // Upgrade-compatibility: `legacyMcpConfigHash` must be the sha256 of the
    // raw merged config *including* the ephemeral loopback port, so that
    // `resolveCliSessionReuse` can accept bindings persisted by pre-fix
    // gateways. It must differ from the canonical `mcpConfigHash` when any
    // loopback URL contains a port.
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-legacy-hash-");

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {},
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http" as const,
            url: "http://127.0.0.1:62949/mcp",
            headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
          },
        },
      },
    });

    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.legacyMcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.legacyMcpConfigHash).not.toBe(prepared.mcpConfigHash);

    // Byte-exact reproduction of what the pre-fix code hashed: JSON.stringify
    // of the merged config (with the literal port) followed by a trailing
    // newline. Any drift here would mean pre-fix bindings still get wiped.
    const expectedLegacyInput = `${JSON.stringify(
      {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:62949/mcp",
            headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
          },
        },
      },
      null,
      2,
    )}\n`;
    const expectedLegacyHash = crypto
      .createHash("sha256")
      .update(expectedLegacyInput)
      .digest("hex");
    expect(prepared.legacyMcpConfigHash).toBe(expectedLegacyHash);

    await prepared.cleanup?.();
  });

  it("changes mcpConfigHash when a user-authored plugin HTTP MCP server changes port", async () => {
    // Guards against over-broad canonicalization: port stripping must apply
    // *only* to the gateway overlay (`additionalConfig`), never to
    // user-authored plugin MCP endpoints. If a configured plugin HTTP server
    // moves from host:1234 to host:5678, that's a real tool-surface change —
    // the stored CLI session must be invalidated so the CLI process doesn't
    // reuse state pointing at a stale backend.
    const makeWorkspaceWithHttpPlugin = async (label: string, port: number) => {
      const workspaceDir = await tempHarness.createTempDir(
        `openclaw-cli-bundle-mcp-user-http-${label}-`,
      );
      const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "http-probe");
      await fs.mkdir(pluginRoot, { recursive: true });
      await writeClaudeBundleManifest({
        homeDir: workspaceDir,
        pluginId: "http-probe",
        manifest: { name: "http-probe" },
      });
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              httpProbe: {
                type: "http",
                url: `http://example.internal:${port}/mcp`,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      return workspaceDir;
    };

    const workspaceDirA = await makeWorkspaceWithHttpPlugin("a", 1234);
    const workspaceDirB = await makeWorkspaceWithHttpPlugin("b", 5678);
    const config: OpenClawConfig = {
      plugins: { entries: { "http-probe": { enabled: true } } },
    };

    const preparedA = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir: workspaceDirA,
      config,
    });
    const preparedB = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir: workspaceDirB,
      config,
    });

    expect(preparedA.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preparedB.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preparedA.mcpConfigHash).not.toBe(preparedB.mcpConfigHash);

    await preparedA.cleanup?.();
    await preparedB.cleanup?.();
  });

  it("changes mcpConfigHash when the loopback overlay headers change", async () => {
    // Non-ephemeral fields on the loopback overlay (server name, type, headers)
    // must still contribute to session identity so a real transport change
    // (e.g. auth header shape) invalidates the stored CLI session.
    const workspaceDir = await tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-loopback-headers-",
    );

    const makeLoopbackWithHeader = (authHeader: string) => ({
      mcpServers: {
        openclaw: {
          type: "http" as const,
          url: "http://127.0.0.1:62949/mcp",
          headers: { Authorization: authHeader },
        },
      },
    });

    const preparedA = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {},
      additionalConfig: makeLoopbackWithHeader("Bearer ${OPENCLAW_MCP_TOKEN}"),
    });
    const preparedB = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir,
      config: {},
      additionalConfig: makeLoopbackWithHeader("Bearer ${OPENCLAW_MCP_V2_TOKEN}"),
    });

    expect(preparedA.mcpConfigHash).not.toBe(preparedB.mcpConfigHash);

    await preparedA.cleanup?.();
    await preparedB.cleanup?.();
  });

  it("preserves extra env values alongside generated MCP config", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-env-");

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: {},
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

  it("injects codex MCP config overrides with env-backed loopback headers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: {
        command: "codex",
        args: ["exec", "--json"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex",
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
            },
          },
        },
      },
    });

    expect(prepared.backend.args).toEqual([
      "exec",
      "--json",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.backend.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.cleanup).toBeUndefined();
  });

  it("writes Gemini system settings for bundle MCP servers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
      },
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("loopback-token-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer loopback-token-123");

    await prepared.cleanup?.();
  });
});
