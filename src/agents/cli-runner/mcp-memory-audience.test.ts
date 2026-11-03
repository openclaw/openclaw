import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../plugins/memory-audience.js";
import { fakeSessionOwner } from "../../plugins/memory-audience.test-support.js";

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
  resolveLoadedMemoryProviderKind: () => "native",
}));

import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";

const STORE_PATH = "/tmp/openclaw-cli-mcp-memory-audience/main.sqlite";

// One admitted owner CLI turn over a current direct root row.
function admittedTurn() {
  const sessionKey = `agent:main:telegram:direct:${randomUUID()}`;
  const entry = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    chatType: "direct" as const,
    updatedAt: 1,
  };
  fakeSessionOwner.rows.set(sessionKey, entry);
  return {
    sessionKey,
    entry,
    run: {
      config: {},
      sessionId: entry.sessionId,
      senderIsOwner: true,
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
    fakeSessionOwner.reset();
  });

  it("grants an owner's direct CLI turn the owner-private audience until run end", async () => {
    const turn = admittedTurn();

    const resolved = await resolveCliMcpMemoryAudience(turn.run, turn.grant);

    expect(resolved.memoryAudience).toEqual({ kind: "owner-private", agentId: "main" });
    const audience = resolved.memoryAudience!;
    expect(() => assertMemoryAudienceSession(audience, turn.sessionKey)).not.toThrow();
    expect(fakeSessionOwner.activeLeases).toBe(1);
    resolved.release();
    expect(fakeSessionOwner.activeLeases).toBe(0);
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("released");
  });

  it("resolves nothing without an admitted session row", async () => {
    const turn = admittedTurn();

    const resolved = await resolveCliMcpMemoryAudience(
      { ...turn.run, sessionEntry: undefined },
      turn.grant,
    );

    expect(resolved.memoryAudience).toBeUndefined();
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });
});
