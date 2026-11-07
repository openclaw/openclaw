import { describe, expect, it, vi } from "vitest";
import { handleRouteError } from "./routes/agent.shared.js";
import type { BrowserResponse } from "./routes/types.js";
import {
  BrowserTargetCrashedError,
  isBrowserTargetCrashed,
  markBrowserTargetCrashed,
  toBrowserTargetCrashedError,
} from "./target-crash.js";

function fakeResponse() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("browser target crash state", () => {
  it("tracks crashes per profile endpoint", () => {
    markBrowserTargetCrashed("http://127.0.0.1:19101/", "T1");

    expect(isBrowserTargetCrashed("http://127.0.0.1:19101", "T1")).toBe(true);
    expect(isBrowserTargetCrashed("http://127.0.0.1:19102", "T1")).toBe(false);
    expect(isBrowserTargetCrashed("http://127.0.0.1:19101", "T2")).toBe(false);
  });

  it("maps Playwright crash wording onto the tab-scoped error", () => {
    expect(toBrowserTargetCrashedError(new Error("page.screenshot: Target crashed"))).toMatchObject(
      {
        name: "BrowserTargetCrashedError",
        message: new BrowserTargetCrashedError().message,
      },
    );
    expect(toBrowserTargetCrashedError(new BrowserTargetCrashedError())).toBeInstanceOf(
      BrowserTargetCrashedError,
    );
    expect(
      toBrowserTargetCrashedError(new Error("page.goto: Timeout 30000ms exceeded")),
    ).toBeNull();
  });

  it("returns a 409 with new-tab guidance instead of browser-wide unavailability", () => {
    const res = fakeResponse();

    handleRouteError(res as unknown as BrowserResponse, new Error("page.route: Target crashed"));

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: new BrowserTargetCrashedError().message });
    expect(new BrowserTargetCrashedError().message).not.toContain("currently unavailable");
  });
});
