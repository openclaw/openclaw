import { describe, expect, it } from "vitest";
import { resolvePreparedThreadBindingLifecycle } from "./thread-bindings.state.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

describe("prepared Discord expiry", () => {
  it.each([
    [100, 50, 10, 10, { expiresAt: 60, reason: "idle-expired" }],
    [100, 100, 10, 10, { expiresAt: 110, reason: "idle-expired" }],
    [100, 200, 10, 10, { expiresAt: 110, reason: "max-age-expired" }],
    [100, 100, 0, 0, {}],
    [100, Number.NaN, 10, 10, { expiresAt: 110, reason: "max-age-expired" }],
    [0, 100, 10, 10, { expiresAt: 110, reason: "idle-expired" }],
    [Infinity, -1, 10, 10, {}],
  ])(
    "preserves prepared deadlines for boundAt=%s lastActivityAt=%s idle=%s max=%s expiry=%j",
    (boundAt, lastActivityAt, idle, max, expiry) => {
      const record: ThreadBindingRecord = {
        accountId: "default",
        channelId: "channel",
        threadId: "thread",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:expiry",
        agentId: "main",
        boundBy: "test",
        boundAt,
        lastActivityAt,
      };
      expect(
        resolvePreparedThreadBindingLifecycle({ record, idleTimeoutMs: idle, maxAgeMs: max }),
      ).toEqual({ idleTimeoutMs: idle, maxAgeMs: max, ...expiry });
    },
  );
});
