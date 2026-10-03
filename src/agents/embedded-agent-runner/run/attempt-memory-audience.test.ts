import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerRuntime: undefined as unknown,
  resolve: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: () => (mocks.providerRuntime ? "native" : undefined),
}));
vi.mock("../../../plugins/memory-audience.js", () => ({
  assertMemoryAudienceSession: vi.fn(),
  isHostMemoryAudience: () => true,
  resolveMemoryAudienceFromEntry: mocks.resolve,
}));
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn, debug: vi.fn() } }));

import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";

const attempt = {
  agentId: "main",
  sessionKey: "agent:main:subagent:child",
  sessionId: "child-session",
  senderIsOwner: false,
  admission: { entry: { sessionId: "child-session", updatedAt: 1 }, storePath: "/tmp/main.sqlite" },
};

describe("embedded attempt memory audience", () => {
  beforeEach(() => {
    mocks.providerRuntime = undefined;
    mocks.resolve.mockReset();
    mocks.warn.mockReset();
  });

  it("resolves no audience, lineage, or leases for a legacy memory owner", async () => {
    const resolved = await resolveEmbeddedAttemptMemoryAudience(attempt);

    expect(resolved.memoryAudience).toBeUndefined();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
