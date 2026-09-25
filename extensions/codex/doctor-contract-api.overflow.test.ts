// Codex tests cover doctor binding migration at namespace overflow.
import fs from "node:fs/promises";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { describe, expect, it } from "vitest";
import {
  createBindingMigrationFixture,
  createDoctorContext,
  openBindingStore,
  removeCodexDoctorFixture,
} from "./doctor-contract-api.test-helpers.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

describe("codex doctor binding migration overflow", () => {
  it("retains a binding sidecar without touching live rows when the binding store is full", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "full-store",
      threadId: "thread-full",
    });
    const store = openBindingStore(fixture.env);
    await store.register("conversation:occupied", {
      version: 1,
      state: "active",
      binding: { threadId: "thread-occupied", cwd: "/repo" },
    });
    const baseContext = createDoctorContext(fixture.env);
    const fullParams = {
      ...fixture.params,
      context: {
        openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
          const opened = baseContext.openPluginStateKeyedStore<T>(options);
          return {
            ...opened,
            async registerIfAbsent(): Promise<boolean> {
              throw Object.assign(
                new Error(
                  `Plugin state namespace ${CODEX_APP_SERVER_BINDING_NAMESPACE} for codex reached its ${CODEX_APP_SERVER_BINDING_MAX_ENTRIES}-row limit.`,
                ),
                { code: "PLUGIN_STATE_LIMIT_EXCEEDED" },
              );
            },
          };
        },
      },
    };

    const result = await fixture.migration.migrateLegacyState(fullParams);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("row limit")]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(store.lookup("conversation:occupied")).resolves.toMatchObject({
      state: "active",
      binding: { threadId: "thread-occupied" },
    });
    expect(await store.entries()).toHaveLength(1);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("does not resurrect a cleared legacy thread when doctor revisits its sidecar", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "capacity-recovery",
      threadId: "thread-old",
    });
    const syncState = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>(
      "codex",
      {
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: fixture.env,
      },
    );
    const facade = createCodexAppServerBindingStore(syncState);
    const legacy = {
      kind: "conversation" as const,
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    };
    await facade.mutate(legacy, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });
    await facade.mutate(legacy, { kind: "clear" });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    // The canonical cleared marker wins over the retained sidecar's stale
    // active binding: doctor archives the source without importing its row.
    expect(result.warnings).toEqual([]);
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    expect(syncState.lookup(bindingStoreKey(legacy))).toMatchObject({ state: "cleared" });
    expect(facade.read(legacy)).toBeUndefined();

    await removeCodexDoctorFixture(fixture.stateDir);
  });
});
