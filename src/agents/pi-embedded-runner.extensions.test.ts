import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearEmbeddedExtensionFactories,
  listEmbeddedExtensionFactories,
} from "../plugins/embedded-extension-factory.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../plugins/loader.js";
import { buildEmbeddedExtensionFactories } from "./pi-embedded-runner/extensions.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

afterEach(() => {
  clearPluginLoaderCache();
  clearEmbeddedExtensionFactories();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("buildEmbeddedExtensionFactories", () => {
  it("includes plugin-registered embedded extension factories and restores them from cache", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-embedded-ext-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "embedded-ext",
      body: `export default { id: "embedded-ext", register(api) {
  api.registerEmbeddedExtensionFactory((pi) => {
    pi.on("session_start", () => undefined);
  });
} };`,
    });

    const options = {
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginFile] },
          allow: ["embedded-ext"],
        },
      },
    };

    loadOpenClawPlugins(options);

    const firstFactories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    expect(firstFactories).toHaveLength(1);
    expect(listEmbeddedExtensionFactories()).toHaveLength(1);

    clearEmbeddedExtensionFactories();
    expect(listEmbeddedExtensionFactories()).toHaveLength(0);

    loadOpenClawPlugins(options);

    const cachedFactories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    expect(cachedFactories).toHaveLength(1);

    const handlers = new Map<string, Function>();
    void cachedFactories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    expect(handlers.has("session_start")).toBe(true);
  });
});
