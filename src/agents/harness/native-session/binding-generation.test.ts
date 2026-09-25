import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  combineNativeSessionBindingAuthority,
  createNativeSessionBindingAuthority,
} from "./binding-authority.js";
import {
  reclaimNativeSessionGeneration,
  resolveNativeSessionBinding,
  type NativeSessionGenerationOperations,
} from "./binding-generation.js";

const createSupersededError = (sessionId: string) =>
  new Error(`Session generation is no longer current: ${sessionId}`);

describe("native session binding generation", () => {
  it("fences an already-readable binding when its admitted session generation rotates", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "native-readable-authority-",
      layout: "state-only",
      applyEnv: false,
    });
    const storePath = path.join(fixture.stateDir, "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:readable",
    };
    const scope = { agentId: target.agentId, sessionKey: target.sessionKey, storePath };
    const binding = { value: "current-native-owner" };
    const reads = vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker");
    try {
      await upsertSessionEntryCore(scope, { sessionId: target.sessionId, updatedAt: 1 });
      reads.mockClear();
      const resolved = await resolveNativeSessionBinding({
        target,
        storePath,
        readBinding: () => binding,
        createSupersededError,
      });
      expect(resolved.binding).toEqual(binding);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(combineNativeSessionBindingAuthority(resolved.authority, resolved.authority)).toBe(
        resolved.authority,
      );
      let peerActive = true;
      const peer = createNativeSessionBindingAuthority(
        resolved.authority.lineage.map((lineage) => ({ ...lineage, read: { ...lineage.read } })),
        () => {
          if (!peerActive) {
            throw new Error("peer authority closed");
          }
        },
      );
      const combined = combineNativeSessionBindingAuthority(resolved.authority, peer);
      reads.mockClear();
      const effect = vi.fn(() => binding);
      await expect(combined.withCurrent(effect)).resolves.toBe(binding);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls[0]?.[0]).toHaveLength(1);
      expect(effect).toHaveBeenCalledTimes(1);

      peerActive = false;
      effect.mockClear();
      await expect(combined.withCurrent(effect)).rejects.toThrow("peer authority closed");
      expect(effect).not.toHaveBeenCalled();
      peerActive = true;
      const conflicting = createNativeSessionBindingAuthority(
        peer.lineage.map((lineage) => ({
          read: lineage.read,
          previousSessionId: lineage.previousSessionId,
          createSupersededError: lineage.createSupersededError,
          sessionId: "different-generation",
        })),
        () => {},
      );
      reads.mockClear();
      await expect(
        combineNativeSessionBindingAuthority(resolved.authority, conflicting).withCurrent(effect),
      ).rejects.toThrow("Session generation is no longer current: different-generation");
      expect(reads.mock.calls[0]?.[0]).toHaveLength(1);
      expect(effect).not.toHaveBeenCalled();

      await patchSessionEntryCore(scope, () => ({ sessionId: "session-successor" }));
      expect(resolved.assertCurrent).toThrow("Session generation is no longer current");
      await expect(combined.withCurrent(effect)).rejects.toThrow(
        "Session generation is no longer current",
      );
      expect(effect).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      await fixture.cleanup();
    }
  });

  it("rejects an already-readable binding owned by a stale admitted session", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "native-readable-stale-",
      layout: "state-only",
      applyEnv: false,
    });
    const storePath = path.join(fixture.stateDir, "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "session-stale",
      sessionKey: "agent:main:readable",
    };
    try {
      await upsertSessionEntryCore(
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath,
        },
        { sessionId: "session-current", updatedAt: 1 },
      );
      await expect(
        resolveNativeSessionBinding({
          target,
          storePath,
          readBinding: () => ({ value: "stale-native-owner" }),
          createSupersededError,
        }),
      ).rejects.toThrow("Session generation is no longer current");
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves caller authority for a scoped session with no durable row", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "native-readable-ephemeral-",
      layout: "state-only",
      applyEnv: false,
    });
    const storePath = path.join(fixture.stateDir, "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "session-ephemeral",
      sessionKey: "agent:main:ephemeral",
    };
    let active = true;
    try {
      await upsertSessionEntryCore(
        {
          agentId: target.agentId,
          sessionKey: "agent:main:other",
          storePath,
        },
        { sessionId: "session-other", updatedAt: 1 },
      );
      const binding = { value: "ephemeral-native-owner" };
      const resolved = await resolveNativeSessionBinding({
        target,
        storePath,
        readBinding: () => binding,
        createSupersededError,
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller authority closed");
          }
        },
      });
      expect(resolved.binding).toEqual(binding);
      expect(resolved.assertCurrent).not.toThrow();

      active = false;
      expect(resolved.assertCurrent).toThrow("caller authority closed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not bridge two generations when the host rotates during a predecessor wait", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "native-predecessor-wait-",
      layout: "state-only",
      applyEnv: false,
    });
    const storePath = path.join(fixture.stateDir, "sessions.json");
    const previous = {
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:compaction",
    };
    const target = { ...previous, sessionId: "current" };
    const next = { ...previous, sessionId: "next" };
    const scope = { agentId: previous.agentId, sessionKey: previous.sessionKey, storePath };
    const binding = { value: "native-owner" };
    let bindingSessionId = previous.sessionId;
    let finishPreparation!: () => void;
    let markPreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    const preparationReleased = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const generation: NativeSessionGenerationOperations = {
      prepareReclaim: async () => {
        markPreparationStarted();
        await preparationReleased;
        return { kind: "verify", expectedPreviousSessionId: bindingSessionId };
      },
      adopt: async (_expectedPreviousSessionId, assertCurrent, authority) => {
        const adopt = () => {
          assertCurrent();
          bindingSessionId = target.sessionId;
          return "adopted" as const;
        };
        return authority ? authority.withCurrent(adopt) : adopt();
      },
      reclaim: async (_expectedPreviousSessionId, assertCurrent, authority) => {
        const reclaim = () => {
          assertCurrent();
          throw new Error("Stale reclaim is disabled");
        };
        return authority ? authority.withCurrent(reclaim) : reclaim();
      },
    };
    try {
      await upsertSessionEntryCore(scope, { sessionId: previous.sessionId, updatedAt: 1 });
      await patchSessionEntryCore(scope, () => ({ sessionId: target.sessionId }));
      const outcome = reclaimNativeSessionGeneration({
        target,
        storePath,
        generation,
        reclaimStale: false,
        createSupersededError,
      }).catch((error: unknown) => error);
      await preparationStarted;
      await patchSessionEntryCore(scope, () => ({ sessionId: next.sessionId }));
      finishPreparation();

      expect(await outcome).toMatchObject({
        message: `Session generation is no longer current: ${target.sessionId}`,
      });
      expect(bindingSessionId === previous.sessionId ? binding : undefined).toEqual(binding);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        sessionId: next.sessionId,
        previousSessionId: target.sessionId,
      });
      await expect(
        reclaimNativeSessionGeneration({
          target: next,
          storePath,
          generation,
          reclaimStale: false,
          createSupersededError,
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
