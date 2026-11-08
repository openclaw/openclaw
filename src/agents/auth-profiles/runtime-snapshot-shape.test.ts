import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreMetadataRevision,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { createSnapshotStore } from "./runtime-snapshots.test-support.js";

const agentDir = "/tmp/openclaw-auth-snapshot-shape";
// One store: a second createSnapshotStore() would differ in timestamps, not shape.
const store = createSnapshotStore("shape-access");

describe("runtime auth snapshot metadata shape", () => {
  beforeEach(() => void prepareSharedAuthStoreOwnershipForNative());
  afterEach(() => clearRuntimeAuthProfileStoreSnapshots());

  it("ignores the unresolved-versus-empty external profile shape", () => {
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const before = getRuntimeAuthProfileStoreMetadataRevision(agentDir);
    // The slow-secrets load resolves the same store to "no external profiles".
    setRuntimeAuthProfileStoreSnapshot(
      {
        ...store,
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: true,
      },
      agentDir,
    );
    expect(getRuntimeAuthProfileStoreMetadataRevision(agentDir)).toBe(before);
  });

  it("still reports a real profile change", () => {
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const before = getRuntimeAuthProfileStoreMetadataRevision(agentDir);
    const changed = { ...store, profiles: {} };
    setRuntimeAuthProfileStoreSnapshot(changed, agentDir);
    expect(getRuntimeAuthProfileStoreMetadataRevision(agentDir)).toBeGreaterThan(before);
  });
});
