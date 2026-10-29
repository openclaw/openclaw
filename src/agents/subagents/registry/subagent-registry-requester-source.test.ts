import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { restoreGatewayOperatorSource } from "../../../gateway/operator-run-recovery.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-authority.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  captureSubagentRequesterSource,
  getUnrestorableSubagentCompletionSourceReason,
  restoreSubagentRequesterSource,
} from "./subagent-registry-requester-source.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof readSessionEntryReadOnlyInWorker>(),
  restore: vi.fn<typeof restoreGatewayOperatorSource>(),
  capture: vi.fn<typeof captureOperatorToolGatewayContinuationContext>(),
  bindings: new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>>
  >(),
  rows: new Map<string, SubagentRunRecord>(),
  require: vi.fn(),
  retired: false,
}));
// mock-isolation: Requester lifecycle reads use fixture entries without opening a real session store.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: mocks.read,
}));
// mock-isolation: Authority restoration uses the test snapshot instead of admitting a live operator source.
vi.mock("../../../gateway/operator-run-recovery.js", () => ({
  restoreGatewayOperatorSource: mocks.restore,
}));
// mock-isolation: Captured continuation authority is supplied by the fixture, not the live gateway.
vi.mock("../../../gateway/server-plugin-in-process-authority.js", () => ({
  captureOperatorToolGatewayContinuationContext: mocks.capture,
}));
// mock-isolation: Completion bindings and retirement state belong exclusively to the fixture maps.
vi.mock("./subagent-registry-memory.js", () => ({
  getCurrentSubagentRunOwner: (_rows: unknown, row: SubagentRunRecord) =>
    mocks.rows.get(row.runId) === row ? row : undefined,
  subagentRuns: {
    hasCompletionAuthority: (row: SubagentRunRecord) => mocks.bindings.has(row.runId),
    requireCompletionAuthority: mocks.require,
    isCompletionAuthorityRetired: () => mocks.retired,
    bindCompletionAuthority: (
      row: SubagentRunRecord,
      authority: NonNullable<
        Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
      >,
    ) => mocks.bindings.set(row.runId, authority),
  },
}));
// mock-isolation: Source fencing is controlled by the fixture without consulting live registry authority.
vi.mock("./subagent-registry-persistence.js", () => ({
  assertSubagentRegistryWriteSourceCurrent: () => {},
}));

function source() {
  return {
    version: 1 as const,
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "requester-id",
    lifecycleRevision: "requester-revision",
    sourceRunId: "requester-turn",
    snapshot: {
      profileId: "original-profile",
      scopes: ["operator.write"],
      assignedRole: null,
      githubLogin: null,
      grant: null,
      aliasBindingIds: [],
      controlUiAdmin: false,
      localOperator: false,
      sourceIngress: "internal" as const,
      authPolicy: {
        generation: "" as const,
        grantGeneration: "original-grant",
        role: "operator" as const,
        authMethod: "token" as const,
      },
    },
  };
}
function createRow(overrides: Partial<SubagentRunRecord> = {}) {
  return createSubagentRunRecord({
    runId: "child-run",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterTurnRunId: "requester-turn",
    completionRequesterSessionId: "requester-id",
    completionRequesterLifecycleRevision: "requester-revision",
    requesterStorePath: "/private/requester-store",
    requesterDisplayKey: "requester",
    task: "task",
    cleanup: "keep",
    operatorRecoverySource: source(),
    completionAuthorityRequired: true,
    ...overrides,
  });
}
const gateway = {} as NonNullable<ReturnType<GatewayContextResolver>>;
const resolver: GatewayContextResolver = () => gateway;
const original = () =>
  createAdmittedRunOperatorAuthority({
    profileId: "original-profile",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    recoverySnapshot: source().snapshot,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.bindings.clear();
  mocks.retired = false;
  mocks.read.mockResolvedValue({
    sessionId: "requester-id",
    lifecycleRevision: "requester-revision",
    updatedAt: 1,
  });
  const authority = original();
  mocks.restore.mockResolvedValue({
    authority,
    authenticatedUserProfile: {
      profileId: "original-profile",
      displayName: "Original",
      avatarRevision: "",
      hasAvatar: false,
      updatedAt: 1,
    },
    controlUiAdmin: false,
    release: vi.fn(),
  });
  mocks.capture.mockResolvedValue({
    operatorAuthority: authority,
    assertCurrent: () => {},
    signal: new AbortController().signal,
    release: vi.fn(),
    run: (run) => run(),
  });
});
async function restore(entry: SubagentRunRecord) {
  mocks.rows.set(entry.runId, entry);
  bindGatewayContextResolver(entry, resolver);
  await restoreSubagentRequesterSource(entry, resolver, () => true);
}

describe("durable original requester custody", () => {
  it.each([false, true])(
    "round trips and restores channel-less original source (collector=%s)",
    async (collect) => {
      const saved = createRow({ collect, requesterOrigin: undefined });
      const reloaded = rowToSubagentRunRecord(bindSubagentRunRecord(saved))!;
      await restore(reloaded);
      expect(reloaded.requesterOrigin).toBeUndefined();
      expect(reloaded.operatorRecoverySource).toEqual(source());
      expect(mocks.restore).toHaveBeenCalledWith(
        expect.objectContaining({ snapshot: source().snapshot, target: source() }),
      );
      expect(mocks.bindings.get(reloaded.runId)?.operatorAuthority?.profileId).toBe(
        "original-profile",
      );
      await restoreSubagentRequesterSource(reloaded, resolver, () => true);
      expect(mocks.restore).toHaveBeenCalledTimes(1);
    },
  );
  it("retains the original source after the inline turn claim is retired", async () => {
    const entry = createRow({ requesterTurnRunId: undefined });
    await restore(entry);
    expect(mocks.bindings.get(entry.runId)?.operatorAuthority?.profileId).toBe("original-profile");
    expect(entry.operatorRecoverySource?.sourceRunId).toBe("requester-turn");
  });
  it("keeps live incognito custody without persisting source evidence", async () => {
    mocks.read.mockResolvedValue({ sessionId: "incognito", updatedAt: 1, incognito: true });
    await expect(
      captureSubagentRequesterSource({
        authority: original(),
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        requesterTurnRunId: "requester-turn",
        assertCurrent() {},
      }),
    ).resolves.toBeUndefined();
  });
  it("captures only the admitted principal and intersects its original scope ceiling", async () => {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "original-profile",
      scopes: ["operator.write"],
      recoverySnapshot: { ...source().snapshot, scopes: ["operator.write", "operator.admin"] },
      assertCurrent: () => {},
    });
    const captured = await captureSubagentRequesterSource({
      authority,
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      requesterTurnRunId: "requester-turn",
      assertCurrent: () => {},
    });
    expect(captured).toEqual(source());
  });
  it.each(["session", "lifecycle", "turn", "agent", "key"])(
    "rejects mismatched saved %s without invoking policy",
    async (field) => {
      const entry = createRow();
      const saved = entry.operatorRecoverySource!;
      if (field === "session") {
        saved.sessionId = "other";
      }
      if (field === "lifecycle") {
        saved.lifecycleRevision = "other";
      }
      if (field === "turn") {
        saved.sourceRunId = "other";
      }
      if (field === "agent") {
        saved.agentId = "other";
      }
      if (field === "key") {
        saved.sessionKey = "other";
      }
      await restore(entry);
      expect(mocks.bindings.size).toBe(0);
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(getUnrestorableSubagentCompletionSourceReason(entry)).toContain("does not own");
    },
  );
  it.each(["reset", "revision", "archive"])(
    "does not borrow a successor after requester %s",
    async (change) => {
      mocks.read.mockResolvedValue({
        sessionId: change === "reset" ? "successor" : "requester-id",
        lifecycleRevision: change === "revision" ? "successor" : "requester-revision",
        updatedAt: 1,
        ...(change === "archive" ? { archivedAt: 2 } : {}),
      });
      const entry = createRow();
      await restore(entry);
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(mocks.bindings.size).toBe(0);
    },
  );
  it("latches denied policy across repeated activation without ambient fallback", async () => {
    mocks.restore.mockRejectedValue(new Error("Restart recovery operator source policy changed."));
    const entry = createRow();
    await restore(entry);
    await restoreSubagentRequesterSource(entry, resolver, () => true);
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.bindings.size).toBe(0);
    expect(getUnrestorableSubagentCompletionSourceReason(entry)).toContain("no longer authorized");
  });
  it("does not authorize a source whose requester changes during policy preparation", async () => {
    mocks.restore.mockImplementationOnce(async (params) => {
      mocks.read.mockResolvedValue({ sessionId: "successor", updatedAt: 2 });
      await params.prepareCurrent?.();
      throw new Error("unreachable");
    });
    const entry = createRow();
    await restore(entry);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.bindings.size).toBe(0);
  });
  it("rejects a replacement row after continuation capture", async () => {
    const entry = createRow();
    const captured = (await mocks.capture())!;
    mocks.capture.mockImplementationOnce(async () => {
      mocks.rows.set(entry.runId, createRow());
      return captured;
    });
    await expect(restore(entry)).rejects.toThrow("runtime owner");
    expect(mocks.bindings.size).toBe(0);
    expect(captured?.release).toHaveBeenCalledTimes(1);
  });
  it("retries transient storage failure without latching a denial", async () => {
    mocks.read.mockRejectedValueOnce(new Error("temporary storage failure"));
    const entry = createRow();
    await expect(restore(entry)).rejects.toThrow("temporary storage failure");
    expect(getUnrestorableSubagentCompletionSourceReason(entry)).toBeUndefined();
    await restore(entry);
    expect(mocks.bindings.size).toBe(1);
  });
  it("marks a missing source denied while retaining its route-less shape", async () => {
    const entry = createRow({ operatorRecoverySource: undefined });
    await restore(entry);
    expect(getUnrestorableSubagentCompletionSourceReason(entry)).toContain("no restorable");
    expect(entry.requesterOrigin).toBeUndefined();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
