import { DatabaseSync, StatementSync } from "node:sqlite";
import * as state from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { MatrixConfig } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    state.resetPluginStateStoreForTests();
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
  const credentials = state.createPluginStateSyncKeyedStoreForTests("matrix", {
    namespace: "credentials",
    maxEntries: 256,
  });
  credentials.register("account:default", {
    accountId: "default",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "synthetic-directory-token",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  state.resetPluginStateStoreForTests();
});

function authEnv(prefix: string): NodeJS.ProcessEnv {
  return {
    [`${prefix}_HOMESERVER`]: "https://matrix.example.org",
    [`${prefix}_ACCESS_TOKEN`]: "synthetic-token",
  };
}
const named = { accounts: { "Team Ops": {} } };
const namedDefault = {
  defaultAccount: "Team Ops",
  accounts: { ...named.accounts, other: {} },
};
const cases: [string, MatrixConfig, NodeJS.ProcessEnv, string][] = [
  ["named default", namedDefault, {}, "team-ops"],
  ["scoped environment", {}, authEnv("MATRIX_TEAM_X2D_OPS"), "team-ops"],
  ["global environment before sole named account", named, authEnv("MATRIX"), "default"],
];

it.each(cases)("lists %s without host SQLite", async (_name, config, env, selected) => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const matrix: MatrixConfig = {
    ...config,
    dm: { allowFrom: ["matrix:@shared:example.org"] },
    groups: {
      "!shared:example.org": { users: ["@shared:example.org"] },
      "!default:example.org": { account: "default", users: ["@default:example.org"] },
      "!team-ops:example.org": { account: "team-ops", users: ["@team-ops:example.org"] },
    },
  };
  const params = { cfg: { channels: { matrix } }, runtime: createRuntimeEnv() };
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
    { kind: "user", id: `user:@${selected}:example.org` },
  ]);
  expect(await directory.listGroups(params)).toEqual([
    { kind: "group", id: "room:!shared:example.org" },
    { kind: "group", id: `room:!${selected}:example.org` },
  ]);
  expect(sql.map((method) => method.mock.calls)).toEqual(sql.map(() => []));
});
