// Browser tests cover fault-tolerant batch cookie injection.
import { beforeEach, describe, expect, it, vi } from "vitest";

let addCookies: ReturnType<typeof vi.fn>;
let page: Record<string, unknown>;

const getPageForTargetId = vi.fn(async () => page);
const ensurePageState = vi.fn(() => ({}));

vi.mock("./pw-session.js", () => ({
  ensurePageState,
  getPageForTargetId,
}));

const { cookiesSetManyViaPlaywright } = await import("./pw-tools-core.storage.js");

function cookie(name: string) {
  return { name, value: "v", domain: ".example.com", path: "/" };
}

beforeEach(() => {
  addCookies = vi.fn(async (cookies: Array<{ name: string }>) => {
    if (cookies.some((c) => c.name === "bad")) {
      throw new Error("rejected cookie");
    }
  });
  page = { context: () => ({ addCookies }) };
  getPageForTargetId.mockClear();
});

describe("cookiesSetManyViaPlaywright", () => {
  it("continues later batches after rejecting one cookie", async () => {
    const cookies = Array.from({ length: 750 }, (_, i) => cookie(i === 1 ? "bad" : `c${i}`));
    const result = await cookiesSetManyViaPlaywright({ cdpUrl: "http://x", cookies });
    expect(result).toEqual({ added: 749 });
    expect(addCookies).toHaveBeenCalledTimes(1 + 500 + 1);
  });
});
