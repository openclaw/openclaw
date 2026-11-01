import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const { fakeSessionOwner, fakeSessionGenerationModule, fakeSessionEntryReadModule } =
  await vi.hoisted(() => import("../../../plugins/memory-audience.test-support.js"));

const mocks = vi.hoisted(() => ({ native: false, warn: vi.fn(), info: vi.fn() }));

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock(
  "../../../config/sessions/session-delivery-generation.js",
  () => fakeSessionGenerationModule,
);
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => fakeSessionEntryReadModule);
// mock-isolation: Select the memory provider kind without activating a real plugin.
vi.mock("../../../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: () => (mocks.native ? "native" : undefined),
}));
// mock-isolation: captures the attempt's log levels without emitting them.
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn, info: mocks.info, debug: vi.fn() } }));

import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";

const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-attempt-memory-audience/main.sqlite";
const entry = () => ({ sessionId: randomUUID(), lifecycleRevision: randomUUID(), updatedAt: 1 });

const attempt = {
  agentId: "main",
  sessionKey: CHILD_KEY,
  sessionId: "child-session",
  run: { senderIsOwner: false },
  admission: { entry: { sessionId: "child-session", updatedAt: 1 }, storePath: STORE_PATH },
};

// A spawned child whose receipt names its parent's incarnation at spawn time.
function spawnedChildAttempt(kind: "stale" | "unverified") {
  mocks.native = true;
  const parent = { ...entry(), chatType: "direct" as const };
  const child = {
    ...entry(),
    spawnedBy: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  };
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  fakeSessionOwner.rows.set(CHILD_KEY, child);
  if (kind === "stale") {
    fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  } else {
    fakeSessionOwner.pendingKeys.add(ROOT_KEY);
  }
  return {
    ...attempt,
    sessionId: child.sessionId,
    admission: { entry: child, storePath: STORE_PATH },
  };
}

beforeEach(() => {
  mocks.native = false;
  mocks.warn.mockReset();
  mocks.info.mockReset();
  fakeSessionOwner.reset();
});

it.each(["legacy", "stale", "unverified"] as const)(
  "denies %s lineage with the appropriate repair log",
  async (kind) => {
    const params = kind === "legacy" ? attempt : spawnedChildAttempt(kind);
    const resolved = await resolveEmbeddedAttemptMemoryAudience(params);
    expect(resolved.memoryAudience).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(kind === "stale" ? 1 : 0);
    if (kind === "stale") {
      const [message] = mocks.warn.mock.calls[0] as [string];
      expect(message).toContain(`session ${CHILD_KEY} has stale lineage`);
      expect(message).toContain("Respawn or recreate it from a current session");
    }
    if (kind === "legacy") {
      expect(fakeSessionOwner.workerReads).toEqual([]);
    }
    if (kind !== "stale") {
      expect(fakeSessionOwner.activeLeases).toBe(0);
    }
    if (kind === "unverified") {
      expect(mocks.info).toHaveBeenCalledWith(
        expect.stringContaining("could not verify the lineage"),
        expect.objectContaining({ kind: "unverified", sessionKey: CHILD_KEY }),
      );
    }
  },
);

it("takes the canonical requester from admitted run authority, not the session owner", async () => {
  const {
    createAdmittedRunOperatorAuthority,
    prepareAgentRunAdmission,
    createOperationalRunInstanceRef,
  } = await import("../../admitted-run-context.js");
  const { withPostAdmissionExecutionOwnerBinding } =
    await import("../../../audit/execution-owner-binding.js");
  const { assertMemoryAudienceCurrent } = await import("../../../plugins/memory-audience.js");
  mocks.native = true;
  let current = true;
  const runId = randomUUID();
  const prepared = withPostAdmissionExecutionOwnerBinding(
    prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: "canonical-person",
        requesterBound: true,
        scopes: ["operator.write"],
        assertCurrent() {
          if (!current) {
            throw new Error("profile revoked");
          }
        },
      }),
    }),
    () => {},
  );
  const row = { ...entry(), chatType: "direct" as const };
  fakeSessionOwner.rows.set(ROOT_KEY, row);
  const admittedRunContext = await prepared.admit("embedded");
  try {
    const resolved = await resolveEmbeddedAttemptMemoryAudience({
      agentId: "main",
      sessionKey: ROOT_KEY,
      sessionId: row.sessionId,
      admission: { entry: row, storePath: STORE_PATH },
      run: { senderIsOwner: false, admittedRunContext },
    });
    expect(resolved.memoryAudience?.requesterProfileId).toBe("canonical-person");
    current = false;
    expect(() => assertMemoryAudienceCurrent(resolved.memoryAudience!)).toThrow("profile revoked");
    resolved.release();
  } finally {
    prepared.close();
  }
});
