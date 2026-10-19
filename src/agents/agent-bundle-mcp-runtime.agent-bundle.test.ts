import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { setSessionMcpRuntimeScheduler } from "./agent-bundle-mcp-manager-api.js";
import { getOrCreateSessionMcpRuntime } from "./agent-bundle-mcp-manager.test-support.js";
import {
  disposeAllSessionMcpRuntimes,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-tools.js";

const tempDirs: string[] = [];
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

beforeEach(async () => {
  scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
});

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await scheduler.stop();
  clearPluginMetadataLifecycleCaches();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeProbeServer(filePath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    return reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-bundle-probe", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") {
    return reply(message.id, {
        tools: [{
          name: "weather_probe",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
    });
  }
  if (message.method === "tools/call") {
    reply(message.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            pluginRoot: process.env.PLUGIN_ROOT,
            pluginData: process.env.PLUGIN_DATA,
            pluginDataExists: existsSync(process.env.PLUGIN_DATA ?? ""),
            argv: process.argv.slice(2),
          }),
        }],
    });
  }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim()) handle(JSON.parse(line));
});
const shutdown = () => process.exit(0);
process.stdin.on("end", shutdown);
for (const event of ["SIGTERM", "SIGINT"]) process.on(event, shutdown);
`,
  );
}

it("discovers an installed Agent Plugins bundle and executes its real stdio tool", async () => {
  const stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-bundle-runtime-")),
  );
  tempDirs.push(stateDir);
  const pluginId = "agent-bundle-probe";
  const pluginRoot = path.join(stateDir, "extensions", pluginId);
  const workspaceDir = path.join(stateDir, "workspace");
  const bundledPluginsDir = path.join(stateDir, "bundled-plugins-disabled");
  const serverPath = path.join(pluginRoot, "probe-server.mjs");
  const expandedMarkerPath = path.join(pluginRoot, "expanded-marker.txt");
  await Promise.all(
    [pluginRoot, workspaceDir, bundledPluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  await writeProbeServer(serverPath);
  const writeJson = (name: string, value: unknown) =>
    fs.writeFile(path.join(pluginRoot, name), JSON.stringify(value), "utf8");
  await writeJson("plugin.json", { $schema: PLUGIN_SCHEMA, name: pluginId });
  await writeJson("mcp.json", {
    $schema: MCP_SCHEMA,
    mcpServers: {
      weatherProbe: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/probe-server.mjs", "${PLUGIN_ROOT}/expanded-marker.txt"],
      },
    },
  });

  const cfg: OpenClawConfig = {
    plugins: { entries: { [pluginId]: { enabled: true } } },
  };
  const createRuntime = (sessionId: string, runtimeConfig = cfg) =>
    getOrCreateSessionMcpRuntime({
      sessionId,
      sessionKey: `agent:test:${sessionId}`,
      workspaceDir,
      cfg: runtimeConfig,
    });
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    },
    async () => {
      clearPluginMetadataLifecycleCaches();
      const loaded = loadEnabledBundleMcpConfig({ workspaceDir, cfg });
      expect(loaded.diagnostics).toStrictEqual([]);
      const expectedPluginData = path.join(stateDir, "plugin-data", pluginId);
      await expect(fs.stat(expectedPluginData)).rejects.toMatchObject({ code: "ENOENT" });
      const runtime = await createRuntime("agent-bundle-boundary");
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      try {
        expect(await fs.realpath(expectedPluginData)).toBe(expectedPluginData);
        expect((await fs.stat(expectedPluginData)).isDirectory()).toBe(true);
        const tool = expectDefined(
          materialized.tools.find((entry) => entry.name === "weatherProbe__weather_probe"),
          "materialized Agent Plugins weather probe tool",
        );
        expect(getPluginToolMeta(tool)).toMatchObject({
          pluginId: "bundle-mcp",
          mcp: { serverName: "weatherProbe", toolName: "weather_probe" },
        });

        const result = await tool.execute("agent-bundle-boundary-call", {}, undefined, undefined);
        const text = result.content.find((entry) => entry.type === "text")?.text;
        const payload: unknown = JSON.parse(expectDefined(text, "weather probe text result"));
        expect(payload).toEqual({
          pluginRoot,
          pluginData: expectedPluginData,
          pluginDataExists: true,
          argv: [expandedMarkerPath],
        });
      } finally {
        await materialized.dispose();
        await disposeAllSessionMcpRuntimes();
      }

      await fs.rm(expectedPluginData, { recursive: true });
      await fs.writeFile(expectedPluginData, "Agent data-dir collision", "utf8");
      const userDataPath = path.join(stateDir, "user-configured-data-file");
      await fs.writeFile(userDataPath, "user-owned path", "utf8");
      clearPluginMetadataLifecycleCaches();
      const collisionRuntime = await createRuntime("agent-bundle-boundary-collision", {
        ...cfg,
        mcp: {
          servers: {
            userProbe: {
              command: "node",
              args: [serverPath, expandedMarkerPath],
              env: { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: userDataPath },
            },
          },
        },
      });
      try {
        const catalog = await collisionRuntime.getCatalog();

        expect(Object.keys(catalog.servers)).toEqual(["userProbe"]);
        expect(catalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual([
          "userProbe:weather_probe",
        ]);
        expect(catalog.diagnostics).toEqual([
          expect.objectContaining({
            serverName: "weatherProbe",
            message: expect.stringMatching(/unable to prepare PLUGIN_DATA.*EEXIST/iu),
          }),
        ]);
        expect((await fs.stat(expectedPluginData)).isFile()).toBe(true);
        expect((await fs.stat(userDataPath)).isFile()).toBe(true);
      } finally {
        await disposeAllSessionMcpRuntimes();
      }
    },
  );
});
