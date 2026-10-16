import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../plugins/memory-audience.js";
import { fakeSessionOwner } from "../../plugins/memory-audience.test-support.js";

const mocks = vi.hoisted(() => ({ providerKind: "native" as "native" | undefined }));

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock("../../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } =
    await import("../../plugins/memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});
// mock-isolation: selects the loaded memory provider kind without loading plugins.
vi.mock("../../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: () => mocks.providerKind,
}));

import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";

const STORE_PATH = "/tmp/openclaw-cli-mcp-memory-audience/main.sqlite";

// One admitted CLI turn over a current root row of the given chat type.
function admittedTurn(chatType: "direct" | "group", senderIsOwner: boolean) {
  const sessionKey = `agent:main:telegram:${chatType}:${randomUUID()}`;
  const entry = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    chatType,
    updatedAt: 1,
  };
  fakeSessionOwner.rows.set(sessionKey, entry);
  return {
    sessionKey,
    entry,
    run: {
      config: {},
      sessionId: entry.sessionId,
      senderIsOwner,
      sessionEntry: entry,
      sessionTarget: {
        agentId: "main",
        sessionId: entry.sessionId,
        sessionKey,
        storePath: STORE_PATH,
      },
    },
    grant: { agentId: "main", sessionKey },
  };
}

describe("resolveCliMcpMemoryAudience", () => {
  beforeEach(() => {
    mocks.providerKind = "native";
    fakeSessionOwner.reset();
  });

  it("grants an owner's direct CLI turn the owner-private audience until run end", async () => {
    const turn = admittedTurn("direct", true);

    const resolved = await resolveCliMcpMemoryAudience(turn.run, turn.grant);

    expect(resolved.memoryAudience).toEqual({ kind: "owner-private", agentId: "main" });
    const audience = resolved.memoryAudience!;
    expect(() => assertMemoryAudienceSession(audience, turn.sessionKey)).not.toThrow();
    expect(fakeSessionOwner.activeLeases).toBe(1);
    resolved.release();
    expect(fakeSessionOwner.activeLeases).toBe(0);
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("released");
  });

  it("grants a non-owner's group CLI turn only its conversation audience", async () => {
    const turn = admittedTurn("group", false);

    const resolved = await resolveCliMcpMemoryAudience(turn.run, turn.grant);

    expect(resolved.memoryAudience).toEqual({
      kind: "conversation",
      agentId: "main",
      sessionKey: turn.sessionKey,
      sessionId: turn.entry.sessionId,
    });
    resolved.release();
  });

  it("refuses a session reset after the CLI turn was admitted", async () => {
    const turn = admittedTurn("direct", true);
    fakeSessionOwner.rows.set(turn.sessionKey, { ...turn.entry, sessionId: randomUUID() });

    const resolved = await resolveCliMcpMemoryAudience(turn.run, turn.grant);

    expect(resolved.memoryAudience).toBeUndefined();
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });

  it("rejects a granted audience once its session is reset mid-run", async () => {
    const turn = admittedTurn("direct", true);
    const { memoryAudience } = await resolveCliMcpMemoryAudience(turn.run, turn.grant);
    fakeSessionOwner.rows.set(turn.sessionKey, { ...turn.entry, lifecycleRevision: randomUUID() });

    expect(() => assertMemoryAudienceCurrent(memoryAudience!)).toThrow("no longer current");
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });

  it("resolves nothing without an admitted session row or a native memory provider", async () => {
    const turn = admittedTurn("direct", true);

    const rowless = await resolveCliMcpMemoryAudience(
      { ...turn.run, sessionEntry: undefined },
      turn.grant,
    );
    mocks.providerKind = undefined;
    const legacy = await resolveCliMcpMemoryAudience(turn.run, turn.grant);

    expect(rowless.memoryAudience).toBeUndefined();
    expect(legacy.memoryAudience).toBeUndefined();
    expect(fakeSessionOwner.workerReads).toEqual([]);
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });
});
