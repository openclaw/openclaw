import fs from "node:fs";
import path from "node:path";
import * as plugins from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { getRealtimeTranscriptionProvider } from "openclaw/plugin-sdk/realtime-transcription";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, expect, it, vi } from "vitest";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { VoiceCallWebhookServer as WebhookServer } from "./webhook.js";

afterEach(plugins.resetPluginRuntimeStateForTest);
afterEach(vi.unstubAllEnvs);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const providerIds = ["active-stt", "configured-stt"];
function writePluginFiles(dir: string, files: Record<string, string | object>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const contents = typeof value === "string" ? value : JSON.stringify(value);
    fs.writeFileSync(path.join(dir, name), contents);
  }
}

it.each([undefined, "configured-stt-alias"])(
  "discovers STT via %s",
  async (configuredProviderId) => {
    const workspace = tempDirs.make("voice-call-provider-discovery-");
    for (const id of providerIds) {
      writePluginFiles(path.join(workspace, "extensions", id), {
        "index.cjs": `module.exports = { id: "${id}", register(api) {
            api.registerRealtimeTranscriptionProvider({
              id: "${id}", aliases: ["${id}-alias"], label: "${id}",
              isConfigured: ({ providerConfig }) => providerConfig.ready === true,
              createSession: () => { throw new Error("startup must not start transcription"); },
            });
          } };`,
        "openclaw.plugin.json": {
          id,
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          contracts: { realtimeTranscriptionProviders: [id] },
        },
        "package.json": { openclaw: { extensions: ["./index.cjs"] } },
      });
    }
    const cfg = {
      agents: { defaults: { workspace } },
      plugins: {
        allow: providerIds,
        entries: Object.fromEntries(providerIds.map((id) => [id, { enabled: true }])),
      },
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspace, "state"));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(workspace, "extensions"));
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    const activeProvider = getRealtimeTranscriptionProvider("active-stt", cfg);
    assert(activeProvider, "expected the real loader to discover the active fixture provider");
    const registry = plugins.createEmptyPluginRegistry();
    registry.realtimeTranscriptionProviders.push({
      pluginId: "active-stt",
      source: path.join(workspace, "extensions", "active-stt", "index.cjs"),
      provider: activeProvider,
    });
    plugins.setActivePluginRegistry(registry, undefined, "default", workspace);
    const config = createVoiceCallBaseConfig();
    config.serve.port = 0;
    config.streaming.enabled = true;
    config.streaming.provider = configuredProviderId;
    config.streaming.providers = {
      "active-stt": { ready: false },
      [configuredProviderId ?? "configured-stt"]: { ready: true },
    };
    const scheduler = createTestPluginServiceScheduler();
    const manager = new CallManager(config, path.join(workspace, "calls"));
    const server = new WebhookServer(scheduler, config, manager, new MockProvider(), cfg);
    try {
      await server.start();
      expect(server.getMediaStreamHandler()).not.toBeNull();
    } finally {
      await server.stop();
    }
  },
);
