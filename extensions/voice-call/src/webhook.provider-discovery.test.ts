import fs from "node:fs";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { getRealtimeTranscriptionProvider } from "openclaw/plugin-sdk/realtime-transcription";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, expect, it } from "vitest";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { VoiceCallWebhookServer } from "./webhook.js";

afterEach(resetPluginRuntimeStateForTest);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const providerIds = ["active-stt", "configured-stt"];
const writeJson = (dir: string, name: string, value: unknown) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));

it.each([undefined, "configured-stt-alias"])(
  "VoiceCallWebhookServer discovers configured transcription with selection %s",
  async (configuredProviderId) => {
    const root = tempDirs.make("voice-call-provider-discovery-");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    for (const id of providerIds) {
      const pluginDir = path.join(root, "extensions", id);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "index.cjs"),
        `module.exports = { id: "${id}", register(api) {
            api.registerRealtimeTranscriptionProvider({
              id: "${id}", aliases: ["${id}-alias"], label: "${id}",
              isConfigured: ({ providerConfig }) => providerConfig.ready === true,
              createSession: () => { throw new Error("startup must not start transcription"); },
            });
          } };`,
      );
      writeJson(pluginDir, "openclaw.plugin.json", {
        id,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { realtimeTranscriptionProviders: [id] },
      });
      writeJson(pluginDir, "package.json", { openclaw: { extensions: ["./index.cjs"] } });
    }
    const cfg = {
      agents: { defaults: { workspace } },
      plugins: {
        allow: providerIds,
        entries: Object.fromEntries(providerIds.map((id) => [id, { enabled: true }])),
      },
    };
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      async () => {
        const activeProvider = getRealtimeTranscriptionProvider("active-stt", cfg);
        assert(activeProvider, "expected the real loader to discover the active fixture provider");
        const registry = createEmptyPluginRegistry();
        registry.realtimeTranscriptionProviders.push({
          pluginId: "active-stt",
          pluginName: "active-stt",
          source: path.join(root, "extensions", "active-stt", "index.cjs"),
          provider: activeProvider,
        });
        setActivePluginRegistry(registry, undefined, "default", workspace);
        const config = createVoiceCallBaseConfig();
        config.serve.port = 0;
        config.streaming.enabled = true;
        config.streaming.provider = configuredProviderId;
        config.streaming.providers = {
          "active-stt": { ready: false },
          [configuredProviderId ?? "configured-stt"]: { ready: true },
        };
        const server = new VoiceCallWebhookServer(
          createTestPluginServiceScheduler(),
          config,
          new CallManager(config, path.join(root, "calls")),
          new MockProvider(),
          cfg,
        );
        try {
          await server.start();
          expect(server.getMediaStreamHandler()).not.toBeNull();
        } finally {
          await server.stop();
        }
      },
    );
  },
);
