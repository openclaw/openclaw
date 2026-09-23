import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resolveEmbeddedModelSelection } from "./command/model-selection.js";

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("./command/runtime-loaders.js", () => ({
  loadTranscriptResolveRuntime: async () => ({
    resolveSessionTranscriptFile: async ({ sessionEntry }: { sessionEntry?: SessionEntry }) => ({
      sessionEntry,
      sessionFile: "synthetic-transcript",
    }),
  }),
}));
vi.mock("./command/attempt-execution.shared.js", () => ({
  persistAgentSession: async ({ entry }: { entry: SessionEntry }) => entry,
}));

afterEach(() => resetPluginRuntimeStateForTest());

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture",
      providers: ["custom"],
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
      },
    },
  ],
});

it.each([
  { name: "resolved provider-prefixed model", pin: "custom/model", expected: "custom/model" },
  { name: "resolved alias-like model", pin: "middle", expected: "middle" },
  { name: "legacy raw alias once", pin: "latest", expected: "middle", raw: true },
  { name: "configured default alias once", pin: "latest", expected: "middle", use: "default" },
  {
    name: "configured default retained by an exact-only policy",
    pin: "latest",
    expected: "middle",
    use: "default",
    allow: ["custom/other"],
  },
  { name: "explicit alias once", pin: "latest", expected: "middle", use: "explicit" },
  {
    name: "resolved prefix rejected by colliding policy",
    pin: "custom/model",
    expected: "default",
    allow: ["custom/default", "custom/model"],
  },
  {
    name: "resolved prefix allowed by namespace wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/*"],
  },
  {
    name: "locked resolved prefix",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/model"],
    locked: true,
  },
])("preserves $name through command selection", async (fixture) => {
  await withStateDirEnv("command-resolved-pin-", async ({ stateDir }) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: fixture.use === "default" ? "custom/latest" : "custom/default",
          thinkingDefault: "off",
          ...(fixture.allow ? { modelPolicy: { allow: fixture.allow } } : {}),
        },
      },
    };
    const sessionEntry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    if (!fixture.use) {
      applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection: { provider: "custom", model: fixture.pin },
      });
    }
    if (fixture.raw) {
      delete sessionEntry.modelOverrideRouteResolution;
    }
    if (fixture.locked) {
      sessionEntry.modelSelectionLocked = true;
    }
    const sessionKey = "agent:main:resolved-pin";
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      async () => {
        const selection = await resolveEmbeddedModelSelection({
          cfg,
          opts: {
            message: "hello",
            ...(fixture.use === "explicit"
              ? { model: "custom/latest", allowModelOverride: true }
              : {}),
          },
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          sessionId: sessionEntry.sessionId,
          storePath: path.join(stateDir, "sessions.json"),
          sessionAgentId: "main",
          workspaceDir: stateDir,
          pluginsEnabled: false,
          modelManifestContext: { manifestPlugins: metadataSnapshot.plugins },
          configuredThinkingCatalog: [],
          isSubagentLane: false,
          suppressVisibleSessionEffects: false,
          runContext: { messageChannel: "internal" },
        });
        expect(selection).toMatchObject({ provider: "custom", model: fixture.expected });
      },
    );
  });
});
