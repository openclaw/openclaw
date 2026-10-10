import { encodeAcpxRuntimeHandleState, type AcpSessionRecord } from "acpx/runtime";
import { expect, it } from "vitest";
import { makeRuntime, type TestSessionStore } from "./runtime.test-support.js";

function sessionRecord(id: string, acpSessionId: string): AcpSessionRecord {
  return {
    schema: "acpx.session.v1",
    name: id,
    acpxRecordId: id,
    acpSessionId,
    agentCommand: "fixture",
    cwd: "/tmp",
    closed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    lastSeq: 0,
    messages: [],
    cumulative_token_usage: {},
    request_token_usage: {},
    eventLog: {
      active_path: "unused.jsonl",
      segment_count: 0,
      max_segment_bytes: 1024,
      max_segments: 1,
    },
  };
}

function mapStore(seed: AcpSessionRecord[]): TestSessionStore & {
  get(id: string): AcpSessionRecord | undefined;
} {
  const records = new Map(seed.map((record) => [record.acpxRecordId, structuredClone(record)]));
  return {
    get: (id) => {
      const record = records.get(id);
      return record ? structuredClone(record) : undefined;
    },
    async load(sessionId) {
      const record = records.get(sessionId);
      return record ? structuredClone(record) : undefined;
    },
    async save(record) {
      const next = record as AcpSessionRecord;
      records.set(next.acpxRecordId, structuredClone(next));
    },
  };
}

it("persists a fresh-session marker for the closed ACPX record only", async () => {
  const closedKey = "agent:main:acp:closed";
  const keptKey = "agent:main:acp:kept";
  const store = mapStore([
    sessionRecord(closedKey, "stale-session"),
    sessionRecord(keptKey, "kept-session"),
  ]);
  const { runtime } = makeRuntime(store);
  try {
    await runtime.prepareFreshSession({
      sessionKey: closedKey,
      agentId: "main",
      persistedHandle: {
        sessionKey: closedKey,
        agentId: "main",
        backend: "acpx",
        cwd: "/tmp",
        acpxRecordId: closedKey,
        backendSessionId: "stale-session",
        runtimeSessionName: encodeAcpxRuntimeHandleState({
          name: closedKey,
          agent: "codex",
          cwd: "/tmp",
          mode: "persistent",
          acpxRecordId: closedKey,
          backendSessionId: "stale-session",
        }),
      },
    });
  } finally {
    await runtime.shutdown();
  }

  const restarted = makeRuntime(store);
  try {
    await expect(restarted.wrappedStore.load(closedKey)).resolves.toMatchObject({
      acpSessionId: "stale-session",
      closed: true,
      acpx: { reset_on_next_ensure: true },
    });
    await expect(restarted.wrappedStore.load(keptKey)).resolves.toMatchObject({
      acpSessionId: "kept-session",
      closed: false,
    });
    expect(store.get(keptKey)?.acpx?.reset_on_next_ensure).not.toBe(true);
  } finally {
    await restarted.runtime.shutdown();
  }
});
