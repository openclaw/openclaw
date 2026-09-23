import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { getMatrixScopedEnvVarNames } from "./env-vars.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig, MatrixConfig } from "./types.js";

describe("Matrix config directory storage", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      resetPluginStateStoreForTests();
      cleanup();
    }),
  );
  beforeEach(() => {
    for (const key of Object.keys(process.env).filter((name) => name.startsWith("MATRIX_"))) {
      vi.stubEnv(key, undefined);
    }
    const stateDir = tempDirs.make("openclaw-matrix-directory-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    installMatrixTestRuntime({ stateDir });
    const credentials = createPluginStateSyncKeyedStoreForTests("matrix", {
      namespace: "credentials",
      maxEntries: 256,
      overflowPolicy: "reject-new",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    credentials.register("account:default", {
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "synthetic-directory-token",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    resetPluginStateStoreForTests();
  });

  const scopedEnv = getMatrixScopedEnvVarNames("team-ops");
  const cases: {
    name: string;
    config?: MatrixConfig;
    accountId?: string;
    env?: NodeJS.ProcessEnv;
    selected: string;
  }[] = [
    { name: "the default account", selected: "default" },
    {
      name: "the sole named account",
      config: { accounts: { "Team Ops": {} } },
      selected: "team-ops",
    },
    {
      name: "the configured named default",
      config: { defaultAccount: "Team Ops", accounts: { other: {}, "Team Ops": {} } },
      selected: "team-ops",
    },
    {
      name: "an explicit normalized account",
      config: { defaultAccount: "other", accounts: { other: {}, "Team Ops": {} } },
      accountId: " Team Ops ",
      selected: "team-ops",
    },
    {
      name: "the ambiguous-account fallback",
      config: { accounts: { other: {}, "Team Ops": {} } },
      selected: "default",
    },
    {
      name: "an explicitly empty account",
      config: { accounts: { "Team Ops": {} } },
      accountId: "",
      selected: "default",
    },
    {
      name: "a scoped environment account",
      env: {
        [scopedEnv.homeserver]: "https://matrix.example.org",
        [scopedEnv.accessToken]: "synthetic-scoped-token",
      },
      selected: "team-ops",
    },
    {
      name: "global environment auth ahead of a sole named account",
      config: { accounts: { "Team Ops": {} } },
      env: {
        MATRIX_HOMESERVER: "https://matrix.example.org",
        MATRIX_ACCESS_TOKEN: "synthetic-global-token",
      },
      selected: "default",
    },
  ];

  it.each(cases)("lists $name without host SQLite", async (scenario) => {
    for (const [key, value] of Object.entries(scenario.env ?? {})) {
      vi.stubEnv(key, value);
    }
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          ...scenario.config,
          dm: { allowFrom: ["matrix:@shared:example.org"] },
          groups: {
            "!shared:example.org": { users: ["@shared:example.org"] },
            "!default:example.org": { account: "default", users: ["@default:example.org"] },
            "!team-ops:example.org": { account: "team-ops", users: ["@team-ops:example.org"] },
          },
        },
      },
    };
    const params = { cfg, accountId: scenario.accountId, runtime: createRuntimeEnv() };
    const sql = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    const directory = matrixPlugin.directory;
    if (!directory?.listPeers || !directory.listGroups) {
      throw new Error("expected Matrix directory listPeers/listGroups");
    }
    expect(await directory.listPeers(params)).toEqual([
      { kind: "user", id: "user:@shared:example.org" },
      { kind: "user", id: `user:@${scenario.selected}:example.org` },
    ]);
    expect(await directory.listGroups(params)).toEqual([
      { kind: "group", id: "room:!shared:example.org" },
      { kind: "group", id: `room:!${scenario.selected}:example.org` },
    ]);
    console.log(
      "matrix-directory host SQL",
      scenario.name,
      sql.map((method) => method.mock.calls.length),
    );
    for (const method of sql) {
      expect(method).not.toHaveBeenCalled();
    }
  });
});
