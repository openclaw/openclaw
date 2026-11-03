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
vi.mock("./command/attempt-execution.shared.js", () => ({
  persistAgentSession: async ({ entry }: { entry: SessionEntry }) => entry,
}));

afterEach(() => resetPluginRuntimeStateForTest());

const aliases = { latest: "middle", middle: "final" };
const modelIdNormalization = { providers: { custom: { aliases } } };
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "fixture", providers: ["custom"], modelIdNormalization }],
});

const collidingPolicy = ["custom/default", "custom/model"];
const wildcardPolicy = ["custom/default", "custom/custom/*"];
it.each([
  ["latest", "middle", "raw", undefined],
  ["latest", "middle", "default", ["custom/other"]],
  ["latest", "middle", "explicit", undefined],
  ["custom/model", "default", "collision", collidingPolicy],
  ["custom/model", "custom/model", "wildcard", wildcardPolicy],
  ["custom/model", "custom/model", "locked", collidingPolicy],
] as const)("selects %s to %s (%s)", (pin, expected, mode, allow) =>
  withStateDirEnv("command-resolved-pin-", async ({ stateDir }) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: mode === "default" ? "custom/latest" : "custom/default",
          thinkingDefault: "off",
          ...(allow ? { modelPolicy: { allow: [...allow] } } : {}),
        },
      },
    };
    const sessionEntry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    if (mode !== "default" && mode !== "explicit") {
      applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection: { provider: "custom", model: pin },
      });
    }
    if (mode === "raw") {
      delete sessionEntry.modelOverrideRouteResolution;
    }
    sessionEntry.modelSelectionLocked = mode === "locked";
    const sessionKey = "agent:main:resolved-pin";
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      async () => {
        const selection = await resolveEmbeddedModelSelection({
          cfg,
          opts: {
            message: "hello",
            ...(mode === "explicit" ? { model: "custom/latest", allowModelOverride: true } : {}),
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
        expect(selection).toMatchObject({ provider: "custom", model: expected });
      },
    );
  }),
);
