// Telegram tests cover bot access invalid allowFrom warn dedupe bounds.
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom, resetInvalidAllowFromWarnings } from "./bot-access.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

// bot-access.ts creates its subsystem logger at module load, so the logger
// must be replaced by the hoisted module factory rather than a beforeEach spy.
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const createSubsystemLogger = () => {
    const logger = { warn: warnMock, child: () => logger };
    return logger as unknown as ReturnType<typeof actual.createSubsystemLogger>;
  };
  return { ...actual, createSubsystemLogger };
});

const WARN_CACHE_MAX = 256;

function warnedEntries(): string[] {
  return warnMock.mock.calls.map(([line]) => {
    const quoted = /Invalid allowFrom entry: ("[^"]*")/.exec(String(line))?.[1];
    return quoted ? (JSON.parse(quoted) as string) : String(line);
  });
}

function normalizeOutsideTestGuard(list: Array<string | number>) {
  return withEnv({ VITEST: undefined, NODE_ENV: "development" }, () => normalizeAllowFrom(list));
}

afterEach(() => {
  warnMock.mockClear();
  resetInvalidAllowFromWarnings();
});

describe("normalizeAllowFrom invalid-entry warn dedupe", () => {
  it("warns once per invalid entry across repeated calls", () => {
    normalizeOutsideTestGuard(["@someone", "12345"]);
    normalizeOutsideTestGuard(["@someone"]);
    normalizeOutsideTestGuard(["@someone", "@other"]);

    expect(warnedEntries()).toEqual(["@someone", "@other"]);
  });

  it("keeps cached entries suppressed when a duplicate hits the full cache", () => {
    for (let i = 0; i < WARN_CACHE_MAX; i++) {
      normalizeOutsideTestGuard([`@user${i}`]);
    }
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX);

    // Duplicate hits at capacity must not evict unrelated entries or re-warn.
    normalizeOutsideTestGuard(["@user0"]);
    normalizeOutsideTestGuard([`@user${WARN_CACHE_MAX - 1}`]);
    for (let i = 0; i < WARN_CACHE_MAX; i++) {
      normalizeOutsideTestGuard([`@user${i}`]);
    }
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX);
  });

  it("stays bounded and lets evicted entries warn again", () => {
    for (let i = 0; i < WARN_CACHE_MAX; i++) {
      normalizeOutsideTestGuard([`@user${i}`]);
    }

    // A new entry past capacity still warns (cache stays bounded, not frozen).
    normalizeOutsideTestGuard(["@overflow"]);
    expect(warnedEntries()).toContain("@overflow");
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 1);

    // "@user0" was the oldest entry and got evicted by "@overflow"; it may
    // warn again, while still-cached entries remain suppressed.
    normalizeOutsideTestGuard(["@user1"]);
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 1);
    normalizeOutsideTestGuard(["@user0"]);
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 2);
    expect(warnedEntries().at(-1)).toBe("@user0");
  });

  it("does not warn under the test-environment guard", () => {
    normalizeAllowFrom(["@someone"]);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
