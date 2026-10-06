/** Tests Muse CLI bundle-MCP staged XDG generation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { setupCliBundleMcpTestHarness } from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

type MuseStagedSettings = {
  schema_version?: number;
  model?: string;
  mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
};

async function writeFakeMuseHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-muse-home-"));
  await fs.mkdir(path.join(home, "muse"), { recursive: true });
  await fs.writeFile(
    path.join(home, "muse", "settings.json"),
    `${JSON.stringify({ schema_version: 1, model: "muse-test-1" }, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(path.join(home, "muse", "auth.json"), "{}\n", "utf-8");
  return home;
}

async function readStagedSettings(env: Record<string, string> | undefined): Promise<MuseStagedSettings> {
  const staged = path.join(env?.XDG_CONFIG_HOME as string, "muse", "settings.json");
  return JSON.parse(await fs.readFile(staged, "utf-8")) as MuseStagedSettings;
}

describe("prepareCliBundleMcpConfig muse", () => {
  it("stages a Muse XDG home with translated bundle MCP servers", async () => {
    const home = await writeFakeMuseHome();
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "muse-system-settings",
      backend: {
        command: "muse",
        args: ["exec", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-muse",
      config: { plugins: { enabled: false } },
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
        XDG_CONFIG_HOME: home,
        OPENCLAW_MCP_TOKEN: "lb-tk-123",
      },
    });

    try {
      expect(prepared.backend.args).toEqual(["exec", "{prompt}"]);
      expect(prepared.env?.XDG_CONFIG_HOME).not.toBe(home);
      expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
      const raw = await readStagedSettings(prepared.env);
      // Real settings survive; Muse reads streamable-http, not http.
      expect(raw.schema_version).toBe(1);
      expect(raw.model).toBe("muse-test-1");
      expect(raw.mcpServers?.openclaw?.type).toBe("streamable-http");
      expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
      expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
      // Auth is symlinked, never copied.
      const stagedAuth = path.join(prepared.env?.XDG_CONFIG_HOME as string, "muse", "auth.json");
      expect((await fs.lstat(stagedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(stagedAuth)).toBe(path.join(home, "muse", "auth.json"));
    } finally {
      await prepared.cleanup?.();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rewrites staged Muse settings in place for the capture attempt", async () => {
    const home = await writeFakeMuseHome();
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "muse-system-settings",
      backend: { command: "muse" },
      workspaceDir: "/tmp/openclaw-bundle-mcp-muse",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
            },
          },
        },
      },
      env: {
        XDG_CONFIG_HOME: home,
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });
    const attempt = await prepareCliBundleMcpCaptureAttempt({
      mode: "muse-system-settings",
      env: prepared.env,
      captureKey: "attempt-123",
    });

    try {
      // In place: the staged XDG path does not change.
      expect(attempt.env?.XDG_CONFIG_HOME).toBe(prepared.env?.XDG_CONFIG_HOME);
      expect(attempt.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY).toBe("attempt-123");
      const raw = await readStagedSettings(attempt.env);
      expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("attempt-123");
    } finally {
      await attempt.cleanup?.();
      await prepared.cleanup?.();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a Muse capture attempt without prepared staging", async () => {
    await expect(
      prepareCliBundleMcpCaptureAttempt({
        mode: "muse-system-settings",
        env: {},
        captureKey: "attempt-123",
      }),
    ).rejects.toThrow("Muse MCP capture requires prepared XDG staging");
  });

  it("removes the staged Muse XDG home on cleanup", async () => {
    const home = await writeFakeMuseHome();
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "muse-system-settings",
      backend: { command: "muse" },
      workspaceDir: "/tmp/openclaw-bundle-mcp-muse",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: { type: "http", url: "http://127.0.0.1:23119/mcp" },
        },
      },
      env: { XDG_CONFIG_HOME: home },
    });
    const stagedXdg = prepared.env?.XDG_CONFIG_HOME as string;
    await prepared.cleanup?.();
    await expect(fs.stat(stagedXdg)).rejects.toThrow();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("passes Muse web-search-disabled through without staging", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      mode: "muse-system-settings",
      backend: { command: "muse" },
      workspaceDir: "/tmp/openclaw-muse-web-search-disabled",
      toolOverrides: { webSearch: false },
    });
    expect(prepared.env?.XDG_CONFIG_HOME).toBeUndefined();
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    await prepared.cleanup?.();
  });
});
