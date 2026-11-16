import { afterEach, describe, expect, it, vi } from "vitest";
import { DtmfElevationGate, type DtmfElevationOutcome } from "./realtime-dtmf-elevation.js";

const INTER_DIGIT_TIMEOUT_MS = 3_000;

const PIN = "4321";
const inbound = { direction: "inbound" as const, from: "+1 (555) 000-1234" };

function open(
  gate = new DtmfElevationGate({
    pin: PIN,
    config: { prefix: "*", elevatedToolPolicy: "owner", maxAttempts: 3, lockoutMs: 60_000 },
    allowFrom: ["+15550001234"],
  }),
  call: { direction: "inbound" | "outbound"; from: string } = inbound,
) {
  const outcomes: DtmfElevationOutcome[] = [];
  const session = gate.openCall(call, (outcome) => outcomes.push(outcome));
  const press = (digits: string) => {
    for (const digit of digits) {
      session?.acceptDigit(digit);
    }
  };
  return { gate, session, outcomes, press };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DtmfElevationGate", () => {
  it("only opens for inbound calls from allowlisted numbers", () => {
    expect(open().session).toBeDefined();
    expect(open(undefined, { ...inbound, direction: "outbound" }).session).toBeUndefined();
    expect(open(undefined, { ...inbound, from: "+15550009999" }).session).toBeUndefined();
  });

  it("ignores digits until the prefix and submits on #", () => {
    const { session, outcomes, press } = open();
    press(`${PIN}#`);
    expect(outcomes).toEqual([]);
    press("*");
    expect(session?.collecting).toBe(true);
    press(`${PIN}#`);
    expect(outcomes).toEqual([{ kind: "elevated", toolPolicy: "owner" }]);
    expect(session?.collecting).toBe(false);
    expect(session?.toolPolicy).toBe("owner");
  });

  it("restarts entry on * and ignores keys outside 0-9", () => {
    const { session, outcomes, press } = open();
    press("*99*A4D321#");
    expect(outcomes).toEqual([{ kind: "elevated", toolPolicy: "owner" }]);
    expect(session?.toolPolicy).toBe("owner");
  });

  it("submits after the inter-digit timeout and idles on a bare prefix", () => {
    vi.useFakeTimers();
    const { session, outcomes, press } = open();
    press("*");
    vi.advanceTimersByTime(INTER_DIGIT_TIMEOUT_MS);
    expect(session?.collecting).toBe(false);
    expect(outcomes).toEqual([]);
    press(`*${PIN}`);
    vi.advanceTimersByTime(INTER_DIGIT_TIMEOUT_MS - 1);
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(outcomes).toEqual([{ kind: "elevated", toolPolicy: "owner" }]);
  });

  it("submits at 12 digits without revealing the configured length", () => {
    const { outcomes, press } = open();
    press(`*${PIN}`);
    expect(outcomes).toEqual([]);
    press("00000000");
    expect(outcomes).toEqual([{ kind: "rejected", attempt: 1, maxAttempts: 3 }]);
  });

  it("rejects wrong PINs, then locks the caller out across calls until expiry", () => {
    vi.useFakeTimers();
    const first = open();
    first.press("*1#*12345#*4320#");
    expect(first.outcomes).toEqual([
      { kind: "rejected", attempt: 1, maxAttempts: 3 },
      { kind: "rejected", attempt: 2, maxAttempts: 3 },
      { kind: "locked-out", attempt: 3, maxAttempts: 3 },
    ]);
    // A locked-out call accepts nothing more.
    first.press(`*${PIN}#`);
    expect(first.outcomes).toHaveLength(3);
    expect(first.session?.toolPolicy).toBeUndefined();

    // During lockout even the correct PIN is refused without comparison, and the call ends.
    const locked = open(first.gate);
    locked.press(`*${PIN}#`);
    expect(locked.outcomes).toEqual([{ kind: "locked-out", attempt: 3, maxAttempts: 3 }]);
    expect(locked.session?.toolPolicy).toBeUndefined();

    vi.advanceTimersByTime(60_000);
    const afterLockout = open(first.gate);
    afterLockout.press(`*${PIN}#`);
    expect(afterLockout.outcomes).toEqual([{ kind: "elevated", toolPolicy: "owner" }]);
  });

  it("counts failed attempts per caller across calls, so redialing does not reset them", () => {
    vi.useFakeTimers();
    const first = open();
    first.press("*1111#*2222#");
    first.session?.close();
    const second = open(first.gate);
    second.press("*3333#");
    expect(second.outcomes).toEqual([{ kind: "locked-out", attempt: 3, maxAttempts: 3 }]);
    const third = open(first.gate);
    third.press(`*${PIN}#`);
    expect(third.session?.toolPolicy).toBeUndefined();
  });

  it("forgets old failures after the lockout window and clears them on success", () => {
    vi.useFakeTimers();
    const first = open();
    first.press("*1111#*2222#");
    vi.advanceTimersByTime(60_000);
    const second = open(first.gate);
    second.press("*3333#");
    expect(second.outcomes).toEqual([{ kind: "rejected", attempt: 1, maxAttempts: 3 }]);
    second.press(`*${PIN}#`);
    expect(second.session?.toolPolicy).toBe("owner");
    const third = open(first.gate);
    third.press("*1111#");
    expect(third.outcomes).toEqual([{ kind: "rejected", attempt: 1, maxAttempts: 3 }]);
  });

  it("drops pending entry on close", () => {
    const { session, outcomes, press } = open();
    press(`*${PIN}`);
    session?.close();
    press("#");
    expect(outcomes).toEqual([]);
    expect(session?.collecting).toBe(false);
    expect(session?.toolPolicy).toBeUndefined();
  });
});
