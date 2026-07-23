import { describe, expect, it, vi } from "vitest";
import { createMatrixE2eeHealthTracker } from "./e2ee-health.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

type EventOptions = {
  ts?: number;
  sender?: string;
  deviceId?: string;
  senderKey?: string;
};

function encryptedEvent(id: string, options: EventOptions = {}): MatrixRawEvent {
  return {
    event_id: id,
    sender: options.sender ?? "@alice:example.org",
    type: EventType.RoomMessageEncrypted,
    origin_server_ts: options.ts ?? Date.now(),
    content: {
      ...(options.deviceId ? { device_id: options.deviceId } : {}),
      ...(options.senderKey ? { sender_key: options.senderKey } : {}),
    },
  };
}

function recordFailure(
  tracker: ReturnType<typeof createMatrixE2eeHealthTracker>,
  roomId: string,
  event: MatrixRawEvent,
  isInbound = true,
) {
  tracker.recordEncryptedEvent(roomId, event);
  return tracker.recordFailure(roomId, event, new Error("missing key"), isInbound);
}

function recordSuccess(
  tracker: ReturnType<typeof createMatrixE2eeHealthTracker>,
  roomId: string,
  event: MatrixRawEvent,
  isInbound = true,
) {
  tracker.recordEncryptedEvent(roomId, event);
  return tracker.recordSuccess(
    roomId,
    { ...event, type: EventType.RoomMessage, content: { body: "decrypted" } },
    isInbound,
  );
}

function createHealthyTracker(baseMs = Date.now()) {
  return createMatrixE2eeHealthTracker({ getHealthySyncSinceMs: () => baseMs - 60_000 });
}

function degradeDefaultCohort(
  tracker: ReturnType<typeof createMatrixE2eeHealthTracker>,
  baseMs = Date.now(),
) {
  for (const index of [1, 2, 3]) {
    recordFailure(
      tracker,
      "!room:example.org",
      encryptedEvent(`$failed-${index}`, { ts: baseMs + index }),
    );
  }
}

describe("Matrix E2EE health tracker", () => {
  it("degrades after three fresh failures and re-arms after recovery", () => {
    const baseMs = Date.now();
    const tracker = createHealthyTracker(baseMs);
    expect(
      recordFailure(tracker, "!room:example.org", encryptedEvent("$f1", { ts: baseMs + 1 })),
    ).not.toHaveProperty("warning");
    expect(
      recordFailure(tracker, "!room:example.org", encryptedEvent("$f2", { ts: baseMs + 2 })),
    ).not.toHaveProperty("warning");
    expect(
      recordFailure(tracker, "!room:example.org", encryptedEvent("$f3", { ts: baseMs + 3 })),
    ).toHaveProperty("warning");
    expect(
      recordSuccess(tracker, "!room:example.org", encryptedEvent("$recovered", { ts: baseMs + 4 })),
    ).toBe(true);

    expect(
      recordFailure(tracker, "!room:example.org", encryptedEvent("$f4", { ts: baseMs + 5 })),
    ).not.toHaveProperty("warning");
    recordFailure(tracker, "!room:example.org", encryptedEvent("$f5", { ts: baseMs + 6 }));
    expect(
      recordFailure(tracker, "!room:example.org", encryptedEvent("$f6", { ts: baseMs + 7 })),
    ).toHaveProperty("warning");
  });

  it("keeps pre-healthy, stale-window, and arrival-less failures generic", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    try {
      const noHealthy = createMatrixE2eeHealthTracker({});
      expect(
        recordFailure(noHealthy, "!room:example.org", encryptedEvent("$pre-healthy")),
      ).toMatchObject({ freshAfterHealthySync: false, failureCount: 0 });

      const tracker = createHealthyTracker();
      recordFailure(tracker, "!room:example.org", encryptedEvent("$old-1"));
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(recordFailure(tracker, "!room:example.org", encryptedEvent("$new-1"))).toMatchObject({
        freshAfterHealthySync: true,
        failureCount: 1,
      });
      expect(
        tracker.recordFailure(
          "!room:example.org",
          encryptedEvent("$arrival-less"),
          new Error("missing"),
          true,
        ),
      ).toMatchObject({ freshAfterHealthySync: false, failureCount: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores self failures and self successes for health", () => {
    const tracker = createHealthyTracker();
    for (const index of [1, 2, 3]) {
      expect(
        recordFailure(tracker, "!room:example.org", encryptedEvent(`$self-${index}`), false),
      ).toMatchObject({ freshAfterHealthySync: false, failureCount: 0 });
    }
    degradeDefaultCohort(tracker);
    expect(recordSuccess(tracker, "!room:example.org", encryptedEvent("$self-echo"), false)).toBe(
      false,
    );
  });

  it("requires all room and sender cohorts to recover", () => {
    const baseMs = Date.now();
    const tracker = createHealthyTracker(baseMs);
    recordFailure(
      tracker,
      "!home:example.org",
      encryptedEvent("$hermes-failed", { ts: baseMs + 1, sender: "@hermes:example.org" }),
    );
    for (const index of [1, 2]) {
      recordFailure(
        tracker,
        "!kit:example.org",
        encryptedEvent(`$element-failed-${index}`, {
          ts: baseMs + index,
          sender: "@alex:example.org",
        }),
      );
    }
    expect(
      recordSuccess(
        tracker,
        "!home:example.org",
        encryptedEvent("$hermes-success", {
          ts: baseMs + 3,
          sender: "@hermes:example.org",
        }),
      ),
    ).toBe(false);
    expect(
      recordSuccess(
        tracker,
        "!kit:example.org",
        encryptedEvent("$element-success", {
          ts: baseMs + 4,
          sender: "@alex:example.org",
        }),
      ),
    ).toBe(true);
  });

  it("requires the failed sender device cohort to recover", () => {
    const baseMs = Date.now();
    const tracker = createHealthyTracker(baseMs);
    for (const index of [1, 2, 3]) {
      recordFailure(
        tracker,
        "!kit:example.org",
        encryptedEvent(`$device-a-failed-${index}`, {
          ts: baseMs + index,
          sender: "@alex:example.org",
          deviceId: "ELEMENT_A",
          senderKey: "curve-a",
        }),
      );
    }
    expect(
      recordSuccess(
        tracker,
        "!kit:example.org",
        encryptedEvent("$device-b-success", {
          ts: baseMs + 4,
          sender: "@alex:example.org",
          deviceId: "ELEMENT_B",
          senderKey: "curve-b",
        }),
      ),
    ).toBe(false);
    expect(
      recordSuccess(
        tracker,
        "!kit:example.org",
        encryptedEvent("$device-a-success", {
          ts: baseMs + 5,
          sender: "@alex:example.org",
          deviceId: "ELEMENT_A",
          senderKey: "curve-a",
        }),
      ),
    ).toBe(true);
  });

  it("ignores an older delayed failure after a newer success", () => {
    const baseMs = Date.now();
    const tracker = createHealthyTracker(baseMs);
    recordFailure(tracker, "!kit:example.org", encryptedEvent("$a-failed", { ts: baseMs + 1 }));
    recordFailure(
      tracker,
      "!home:example.org",
      encryptedEvent("$b-failed-1", { ts: baseMs + 1, sender: "@hermes:example.org" }),
    );
    recordFailure(
      tracker,
      "!home:example.org",
      encryptedEvent("$b-failed-2", { ts: baseMs + 2, sender: "@hermes:example.org" }),
    );
    const delayed = encryptedEvent("$a-old-delayed", { ts: baseMs + 3 });
    tracker.recordEncryptedEvent("!kit:example.org", delayed);
    expect(
      recordSuccess(tracker, "!kit:example.org", encryptedEvent("$a-new", { ts: baseMs + 4 })),
    ).toBe(false);
    expect(
      tracker.recordFailure("!kit:example.org", delayed, new Error("late"), true),
    ).toMatchObject({ freshAfterHealthySync: false });
    expect(
      recordSuccess(
        tracker,
        "!home:example.org",
        encryptedEvent("$b-success", { ts: baseMs + 5, sender: "@hermes:example.org" }),
      ),
    ).toBe(true);
  });

  it("does not let an older-timestamp success suppress a newer-timestamp failure", () => {
    const baseMs = Date.now() - 1_000;
    const tracker = createHealthyTracker(baseMs);
    recordFailure(tracker, "!kit:example.org", encryptedEvent("$a-failed", { ts: baseMs + 50 }));
    recordFailure(
      tracker,
      "!home:example.org",
      encryptedEvent("$b-failed-1", { ts: baseMs + 50, sender: "@hermes:example.org" }),
    );
    recordFailure(
      tracker,
      "!home:example.org",
      encryptedEvent("$b-failed-2", { ts: baseMs + 50, sender: "@hermes:example.org" }),
    );
    const delayed = encryptedEvent("$a-newer-ts", { ts: baseMs + 200 });
    tracker.recordEncryptedEvent("!kit:example.org", delayed);
    recordSuccess(tracker, "!kit:example.org", encryptedEvent("$a-older-ts", { ts: baseMs + 100 }));
    expect(
      tracker.recordFailure("!kit:example.org", delayed, new Error("late"), true),
    ).toMatchObject({ freshAfterHealthySync: true });
    expect(
      recordSuccess(
        tracker,
        "!home:example.org",
        encryptedEvent("$b-success", { ts: baseMs + 300, sender: "@hermes:example.org" }),
      ),
    ).toBe(false);
  });

  it("does not watermark a non-finite success timestamp", () => {
    const baseMs = Date.now() - 1_000;
    const tracker = createHealthyTracker(baseMs);
    const delayed = encryptedEvent("$delayed", { ts: baseMs + 100 });
    tracker.recordEncryptedEvent("!kit:example.org", delayed);
    recordSuccess(tracker, "!kit:example.org", encryptedEvent("$nan", { ts: Number.NaN }));
    recordFailure(tracker, "!home:example.org", encryptedEvent("$b1", { ts: baseMs + 200 }));
    recordFailure(tracker, "!home:example.org", encryptedEvent("$b2", { ts: baseMs + 200 }));
    expect(
      tracker.recordFailure("!kit:example.org", delayed, new Error("late"), true),
    ).toHaveProperty("warning");
  });

  it("requires retained original arrival metadata for failures", () => {
    const tracker = createHealthyTracker();
    recordFailure(tracker, "!room:example.org", encryptedEvent("$f1"));
    recordFailure(tracker, "!room:example.org", encryptedEvent("$f2"));

    const contradictory = encryptedEvent("$same-event");
    tracker.recordEncryptedEvent("!room:example.org", contradictory);
    tracker.recordSuccess("!room:example.org", contradictory, true);
    expect(
      tracker.recordFailure("!room:example.org", contradictory, new Error("late"), true),
    ).toMatchObject({ freshAfterHealthySync: false, failureCount: 0 });
  });

  it("keeps an evicted failure generic even after a newer success", () => {
    const tracker = createHealthyTracker();
    const evicted = encryptedEvent("$evicted", {
      sender: "@alex:example.org",
      deviceId: "ELEMENT_A",
    });
    tracker.recordEncryptedEvent("!kit:example.org", evicted);
    for (let index = 0; index < 512; index += 1) {
      tracker.recordEncryptedEvent(
        `!pending-${index}:example.org`,
        encryptedEvent(`$pending-${index}`, { sender: `@sender-${index}:example.org` }),
      );
    }
    recordSuccess(
      tracker,
      "!kit:example.org",
      encryptedEvent("$newer", { sender: "@alex:example.org", deviceId: "ELEMENT_A" }),
    );
    recordFailure(tracker, "!room:example.org", encryptedEvent("$other-1"));
    recordFailure(tracker, "!room:example.org", encryptedEvent("$other-2"));
    expect(
      tracker.recordFailure("!kit:example.org", evicted, new Error("late"), true),
    ).toMatchObject({ freshAfterHealthySync: false, failureCount: 0 });
  });

  it("keeps degradation across a new healthy-sync epoch", () => {
    const baseMs = Date.now();
    let healthySyncSinceMs = baseMs - 60_000;
    const tracker = createMatrixE2eeHealthTracker({
      getHealthySyncSinceMs: () => healthySyncSinceMs,
    });
    degradeDefaultCohort(tracker, baseMs);
    healthySyncSinceMs = baseMs;
    recordFailure(
      tracker,
      "!room:example.org",
      encryptedEvent("$after-reconnect", { ts: baseMs + 10 }),
    );
    expect(
      recordSuccess(
        tracker,
        "!room:example.org",
        encryptedEvent("$recovered", { ts: baseMs + 11 }),
      ),
    ).toBe(true);
  });

  it("requires recovery to be newer than failures after degradation", () => {
    const baseMs = Date.now();
    const tracker = createHealthyTracker(baseMs);
    degradeDefaultCohort(tracker, baseMs);
    recordFailure(
      tracker,
      "!room:example.org",
      encryptedEvent("$later-failure", { ts: baseMs + 20 }),
    );
    expect(
      recordSuccess(
        tracker,
        "!room:example.org",
        encryptedEvent("$stale-success", { ts: baseMs + 10 }),
      ),
    ).toBe(false);
    expect(
      recordSuccess(
        tracker,
        "!room:example.org",
        encryptedEvent("$current-success", { ts: baseMs + 21 }),
      ),
    ).toBe(true);
  });

  it("latches conservative degradation when cohort capacity overflows", () => {
    const tracker = createHealthyTracker();
    let overflowCount = 0;
    for (let index = 0; index < 520; index += 1) {
      const state = recordFailure(
        tracker,
        `!room-${index}:example.org`,
        encryptedEvent(`$failed-${index}`, { sender: `@sender-${index}:example.org` }),
      );
      overflowCount += state.cohortOverflowed ? 1 : 0;
    }
    expect(overflowCount).toBe(1);
    for (let index = 0; index < 520; index += 1) {
      expect(
        recordSuccess(
          tracker,
          `!room-${index}:example.org`,
          encryptedEvent(`$success-${index}`, { sender: `@sender-${index}:example.org` }),
        ),
      ).toBe(false);
    }
  });

  it.each([
    { fillerCount: 511, shouldRecover: true },
    { fillerCount: 512, shouldRecover: false },
  ])("bounds encrypted arrivals with $fillerCount fillers", ({ fillerCount, shouldRecover }) => {
    const tracker = createHealthyTracker();
    degradeDefaultCohort(tracker);
    const candidate = encryptedEvent("$candidate", { ts: Date.now() + 10 });
    tracker.recordEncryptedEvent("!room:example.org", candidate);
    for (let index = 0; index < fillerCount; index += 1) {
      tracker.recordEncryptedEvent(
        `!pending-${index}:example.org`,
        encryptedEvent(`$pending-${index}`, { sender: `@sender-${index}:example.org` }),
      );
    }
    expect(tracker.recordSuccess("!room:example.org", candidate, true)).toBe(shouldRecover);
  });

  it.each([
    { fillerCount: 511, shouldDegrade: false },
    { fillerCount: 512, shouldDegrade: true },
  ])("bounds success watermarks with $fillerCount fillers", ({ fillerCount, shouldDegrade }) => {
    const baseMs = Date.now() - 1_000;
    const tracker = createHealthyTracker(baseMs);
    const delayed = encryptedEvent("$delayed", { ts: baseMs + 100 });
    tracker.recordEncryptedEvent("!kit:example.org", delayed);
    recordSuccess(tracker, "!kit:example.org", encryptedEvent("$watermark", { ts: baseMs + 100 }));
    for (let index = 0; index < fillerCount; index += 1) {
      recordSuccess(
        tracker,
        `!success-${index}:example.org`,
        encryptedEvent(`$success-${index}`, {
          ts: baseMs + 100,
          sender: `@sender-${index}:example.org`,
        }),
      );
    }
    recordFailure(tracker, "!room:example.org", encryptedEvent("$other-1", { ts: baseMs + 200 }));
    recordFailure(tracker, "!room:example.org", encryptedEvent("$other-2", { ts: baseMs + 200 }));
    const state = tracker.recordFailure("!kit:example.org", delayed, new Error("late"), true);
    expect("warning" in state).toBe(shouldDegrade);
  });
});
