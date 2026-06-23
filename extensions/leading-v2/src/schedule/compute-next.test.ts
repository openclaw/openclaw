import { describe, expect, it } from "vitest";
import { computeNext, parseHm } from "./compute-next.js";

const TZ = "Asia/Shanghai";

/** Wall-clock parts of an epoch in a tz, for assertions. */
function partsIn(tz: string, epoch: number) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epoch))) {
    m[p.type] = p.value;
  }
  return m;
}

describe("parseHm", () => {
  it("parses valid and rejects invalid", () => {
    expect(parseHm("09:00")).toEqual({ h: 9, m: 0 });
    expect(parseHm("23:59")).toEqual({ h: 23, m: 59 });
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("9:5")).toBeNull();
    expect(parseHm("abc")).toBeNull();
  });
});

describe("computeNext interval", () => {
  it("adds everyMinutes", () => {
    expect(computeNext({ kind: "interval", everyMinutes: 3 }, 1_000_000, TZ)).toBe(1_000_000 + 180_000);
  });
});

describe("computeNext daily (Asia/Shanghai)", () => {
  it("returns today's HH:mm when still ahead", () => {
    // 2026-06-18 08:00 +08:00
    const from = Date.UTC(2026, 5, 18, 0, 0); // 08:00 CST
    const next = computeNext({ kind: "daily", time: "09:00" }, from, TZ);
    const p = partsIn(TZ, next);
    expect(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`).toBe("2026-06-18 09:00");
  });

  it("rolls to tomorrow when the time already passed", () => {
    const from = Date.UTC(2026, 5, 18, 2, 0); // 10:00 CST, past 09:00
    const next = computeNext({ kind: "daily", time: "09:00" }, from, TZ);
    const p = partsIn(TZ, next);
    expect(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`).toBe("2026-06-19 09:00");
  });

  it("rolls across a month boundary", () => {
    const from = Date.UTC(2026, 5, 30, 5, 0); // 2026-06-30 13:00 CST
    const next = computeNext({ kind: "daily", time: "09:00" }, from, TZ);
    const p = partsIn(TZ, next);
    expect(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`).toBe("2026-07-01 09:00");
  });
});

describe("computeNext weekly (Asia/Shanghai)", () => {
  it("finds the next matching weekday at HH:mm", () => {
    // 2026-06-18 is a Thursday (weekday 4). Ask for Monday (1) 09:00.
    const from = Date.UTC(2026, 5, 18, 2, 0); // Thu 10:00 CST
    const next = computeNext({ kind: "weekly", weekday: 1, time: "09:00" }, from, TZ);
    const p = partsIn(TZ, next);
    expect(p.weekday).toBe("Mon");
    expect(`${p.hour}:${p.minute}`).toBe("09:00");
    // Next Monday after Thu 6/18 is 6/22.
    expect(`${p.year}-${p.month}-${p.day}`).toBe("2026-06-22");
  });

  it("same weekday but time passed → next week", () => {
    // Thursday 10:00, ask Thursday (4) 09:00 → +7 days.
    const from = Date.UTC(2026, 5, 18, 2, 0);
    const next = computeNext({ kind: "weekly", weekday: 4, time: "09:00" }, from, TZ);
    const p = partsIn(TZ, next);
    expect(`${p.year}-${p.month}-${p.day}`).toBe("2026-06-25");
  });
});
