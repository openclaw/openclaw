import fs from "node:fs";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readAcpSessionEntryAsync, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import type { withAcpCancellationFixture } from "./manager.cancel-session.worker.test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

type Fixture = Parameters<Parameters<typeof withAcpCancellationFixture>[0]>[0];

export function observeControlRead(
  onPrepared?: () => void,
  beforeRead?: { when: () => boolean; wait: () => Promise<void> },
) {
  const prepare = DEFAULT_DEPS.prepareSessionControlRead;
  let gated = false;
  return vi
    .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
    .mockImplementationOnce(async (params) => {
      const read = await prepare(params);
      onPrepared?.();
      if (!beforeRead) {
        return read;
      }
      return {
        ...read,
        readCurrent: async (cfg: Fixture["target"]["cfg"]) => {
          if (beforeRead.when() && !gated) {
            gated = true;
            await beforeRead.wait();
          }
          return read.readCurrent(cfg);
        },
      };
    });
}

export function createGate(label = "Operation settled before its controlled boundary") {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    open: release.resolve,
    wait: () => {
      entered.resolve();
      return release.promise;
    },
    reached: (operation: PromiseLike<unknown>) =>
      awaitGateBeforeSettlement(entered.promise, operation, label),
  };
}

export function untilAborted(signal: AbortSignal | undefined) {
  return new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function holdEnsure(f: Fixture, gate: ReturnType<typeof createGate>, name: string) {
  f.ensureSession.mockImplementationOnce(async () => {
    await gate.wait();
    return runtimeHandle(f, name);
  });
}

export function holdMetadataWrite(gate: ReturnType<typeof createGate>) {
  const upsert = DEFAULT_DEPS.upsertSessionMeta;
  return vi.spyOn(DEFAULT_DEPS, "upsertSessionMeta").mockImplementationOnce(async (params) => {
    await gate.wait();
    return upsert(params);
  });
}

export function runtimeHandle(f: Fixture, runtimeSessionName: string) {
  return { sessionKey: f.target.sessionKey, backend: "cancellation-proof", runtimeSessionName };
}

export function cancelSession(f: Fixture, reason: string) {
  return f.manager.cancelSession({ ...f.target, reason });
}

export function replaceRuntime(f: Fixture, patch: Partial<SessionAcpMeta> = {}) {
  return upsertAcpSessionMeta({
    ...f.target,
    skipMaintenance: true,
    mutate: (current) => {
      if (!current) {
        throw new Error("Cancellation fixture lost its global ACP metadata.");
      }
      return { ...current, runtimeSessionName: "successor-runtime", state: "running", ...patch };
    },
  });
}

export async function expectSuccessor(f: Fixture, patch: Partial<SessionAcpMeta> = {}) {
  expect((await readAcpSessionEntryAsync(f.target))?.acp).toMatchObject({
    backend: "cancellation-proof",
    runtimeSessionName: "successor-runtime",
    state: "running",
    ...patch,
  });
}

export function locatorSessionKey(sourceKind: "durable" | "incognito", suffix: string) {
  return sourceKind === "incognito"
    ? `agent:main:dashboard:incognito-${suffix}`
    : `agent:main:acp:${suffix}`;
}

export function memoryGuard(f: Fixture, sourceKind: "durable" | "incognito") {
  const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
  const memory = memorySessionActorOwners.read({ agentId: "main", path });
  const check = () => {
    if (sourceKind === "incognito") {
      expect(memory).toBeDefined();
      expect(memorySessionActorOwners.read({ agentId: "main", path })).toBe(memory);
      expect(fs.existsSync(path)).toBe(false);
    }
  };
  check();
  return check;
}

export function startTurn(
  f: Fixture,
  requestId: string,
  options: Partial<
    Pick<Parameters<Fixture["manager"]["runTurn"]>[0], "text" | "admittedRunContext" | "onEvent">
  > = {},
) {
  return f.manager.runTurn({
    ...f.target,
    admittedRunContext: options.admittedRunContext ?? createTestAdmittedRunContext(requestId),
    provenance: "system",
    mode: "prompt",
    text: requestId,
    requestId,
    ...options,
  });
}

export function expectNoRuntimeEffects(f: Fixture, close: Fixture["runtime"]["close"]) {
  expect(f.ensureSession).toHaveBeenCalledOnce();
  expect(f.runTurn).not.toHaveBeenCalled();
  expect(f.cancel).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
}
