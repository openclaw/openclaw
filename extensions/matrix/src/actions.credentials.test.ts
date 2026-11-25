import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matrixMessageActions } from "./actions.js";
import { matrixSetupPlugin } from "./channel.setup.js";
import { openMatrixCredentialsAsyncStore } from "./matrix/credentials-read.js";
import { matrixCredentialsStoreKey } from "./matrix/credentials-state.js";
import { getMatrixRuntime } from "./runtime.js";
import { installMatrixTestRuntime, resetMatrixTestStores } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

vi.mock("openclaw/plugin-sdk/plugin-state-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-state-store-runtime")>()),
  createPluginStateSyncKeyedStore: () => {
    throw new Error("message preparation must await credential storage");
  },
}));

afterEach(async () => {
  await resetMatrixTestStores();
  vi.unstubAllEnvs();
});

describe("Matrix stored-credential message preparation", () => {
  it.each([true, false])(
    "uses current stored credentials for accounts and sends (runtime=%s)",
    async (hasRuntime) => {
      installMatrixTestRuntime();
      const stateDir = getMatrixRuntime().state.resolveStateDir();
      const cfg: CoreConfig = {
        channels: {
          matrix: { homeserver: "https://matrix.example.org", userId: "@bot:example.org" },
        },
      };
      const store = openMatrixCredentialsAsyncStore();
      const key = matrixCredentialsStoreKey("default");
      await store.register(key, {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "synthetic-token",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      if (!hasRuntime) {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        createPluginRuntimeStore({
          pluginId: "matrix",
          errorMessage: "Matrix runtime not initialized",
        }).clearRuntime();
      }
      const payload = { text: "hello" };
      const prepare = () =>
        matrixMessageActions.prepareSendPayload!({
          ctx: { channel: "matrix", action: "send", cfg, accountId: "default", params: {} },
          to: "!fixture:example.org",
          payload,
        });
      const inspect = async () => {
        const sql = observeHostDataSql();
        try {
          const account = await matrixSetupPlugin.config.resolveAccountAsync!(cfg, "default");
          const configured = await matrixSetupPlugin.config.hasConfiguredStateAsync!({ cfg });
          const prepared = await prepare();
          expect(sql.queries).toEqual([]);
          return { account, configured, prepared };
        } finally {
          sql.restore();
        }
      };
      await expect(inspect()).resolves.toMatchObject({
        account: { configured: true },
        configured: true,
        prepared: payload,
      });
      await store.register(key, {
        kind: "revoked",
        accountId: "default",
        revokedAt: "2026-01-02T00:00:00.000Z",
      });
      await expect(inspect()).resolves.toMatchObject({
        account: { configured: false },
        configured: false,
        prepared: null,
      });
    },
  );
});
