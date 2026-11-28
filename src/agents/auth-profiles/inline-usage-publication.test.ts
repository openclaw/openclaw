import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearSnapshot,
  getOwnedSnapshot,
  notePersistedMutation,
  publishSnapshot,
  reportFailure,
  state,
} = vi.hoisted(() => ({
  clearSnapshot: vi.fn(),
  getOwnedSnapshot: vi.fn(),
  notePersistedMutation: vi.fn(),
  publishSnapshot: vi.fn(),
  reportFailure: vi.fn(),
  state: {
    revision: 0,
  },
}));

vi.mock("../../state/openclaw-state-worker-context.js", () => ({}));
vi.mock("./constants.js", () => ({
  reportCommittedInlineAuthFailure: reportFailure,
}));
vi.mock("./credential-observation.js", () => ({
  observeCanonicalAuthProfileCredentials: vi.fn(),
}));
vi.mock("./legacy-source-diagnostic.js", () => ({
  assertAuthProfileMigrationStateAtDatabasePath: vi.fn(),
  prepareAuthProfileMigrationCandidates: vi.fn(
    async ({ assertCurrent }: { assertCurrent: () => void }) => assertCurrent(),
  ),
}));
vi.mock("./mutation-lineage.js", () => ({
  getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath: () => state.revision,
}));
vi.mock("./persisted.js", () => ({
  buildPersistedAuthProfileSecretsStore: (store: unknown) => store,
}));
vi.mock("./runtime-snapshot-owner.js", () => ({
  captureRuntimeAuthProfileLegacyCandidates: () => ({}),
  createEmptyAuthProfileStore: () => ({ profiles: {} }),
  listRuntimeLocalProfileIds: () => [],
  markRuntimePersistedProfiles: (store: unknown) => store,
  mergeLocalAuthProfileStoreWithInheritedStore: (local: unknown) => local,
  runtimeAuthProfileSnapshotSharesOwner: (
    a: { databasePath: string },
    b: { databasePath: string },
  ) => a.databasePath === b.databasePath,
  setRuntimeLocalProfileMetadata: (store: unknown) => store,
}));
vi.mock("./runtime-snapshot-publication.js", () => ({
  publishPreparedRuntimeAuthProfileStoreSnapshot: publishSnapshot,
}));
vi.mock("./runtime-snapshots.js", () => ({
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath: clearSnapshot,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath: getOwnedSnapshot,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner: () => [],
  noteRuntimeAuthProfileStorePersistedMutation: notePersistedMutation,
  recordRuntimeAuthProfilePersistedStore: vi.fn(),
}));
vi.mock("./sqlite-read.js", () => ({
  loadPersistedAuthProfileStoreFromRows: () => ({ profiles: { synthetic: {} } }),
  prepareAgentAuthProfileRowsRead: vi.fn(),
  readSharedAuthProfileRows: vi.fn(),
}));
vi.mock("./state.js", () => ({
  buildPersistedAuthProfileState: (store: unknown) => store,
}));

import { publishInlineAuthFailure } from "./inline-usage-publication.js";
import type { PreparedAuthProfileStoreOwner } from "./types.js";

describe("publishInlineAuthFailure", () => {
  const databasePath = path.join("/synthetic", "agent", "auth-profile.sqlite");
  const owner = {
    databasePath,
    sharedDatabasePath: databasePath,
    env: {},
    location: "agent",
  } as unknown as PreparedAuthProfileStoreOwner;

  beforeEach(() => {
    state.revision = 0;
    clearSnapshot.mockReset();
    getOwnedSnapshot.mockReset();
    notePersistedMutation.mockReset();
    publishSnapshot.mockReset();
    reportFailure.mockReset();
    getOwnedSnapshot.mockReturnValue({
      databasePath,
      agentDir: path.dirname(databasePath),
      owner,
    });
    notePersistedMutation.mockImplementation(() => ++state.revision);
  });

  it("preserves the existing runtime snapshot on a revision conflict", async () => {
    await publishInlineAuthFailure(
      owner,
      { publication: {} as never },
      async () => {
        state.revision += 1;
        return {
          store: { status: "missing" },
          state: { status: "missing" },
          cacheable: false,
        } as never;
      },
      () => {},
    );

    expect(publishSnapshot).not.toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });

  it("still clears the owned runtime snapshot on non-conflict errors", async () => {
    await publishInlineAuthFailure(
      owner,
      { publication: {} as never },
      async () => {
        throw new Error("sqlite read failed");
      },
      () => {},
    );

    expect(publishSnapshot).not.toHaveBeenCalled();
    expect(clearSnapshot).toHaveBeenCalledWith(databasePath, path.dirname(databasePath));
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });
});
