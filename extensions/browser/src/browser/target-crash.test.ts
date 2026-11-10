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

  it("expires crash observations", () => {
    vi.useFakeTimers();
    try {
      markBrowserTargetCrashed("http://127.0.0.1:19107", "T1");
      expect(isBrowserTargetCrashed("http://127.0.0.1:19107", "T1")).toBe(true);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(isBrowserTargetCrashed("http://127.0.0.1:19107", "T1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps Playwright crash wording onto the tab-scoped error", () => {
    expect(toBrowserTargetCrashedError(new Error("page.screenshot: Target crashed"))).toMatchObject(
      {
        name: "BrowserTargetCrashedError",
        message: new BrowserTargetCrashedError().message,
      },
    );
    // Playwright appends a diagnostic block after the crash headline.
    expect(
      toBrowserTargetCrashedError(
        new Error("page.screenshot: Target crashed\nCall log:\n  - taking page screenshot"),
      ),
    ).toMatchObject({ name: "BrowserTargetCrashedError" });
    expect(toBrowserTargetCrashedError(new BrowserTargetCrashedError())).toBeInstanceOf(
      BrowserTargetCrashedError,
    );
    expect(
      toBrowserTargetCrashedError(new Error("page.goto: Timeout 30000ms exceeded")),
    ).toBeNull();
  });

  it("keeps page-script errors that merely contain crash words", () => {
    // A healthy page may throw these exact strings; they are not transport frames.
    expect(toBrowserTargetCrashedError(new Error("target crashed"))).toBeNull();
    expect(toBrowserTargetCrashedError(new Error("Error: target crashed"))).toBeNull();
    expect(toBrowserTargetCrashedError(new Error("renderer crashed while loading"))).toBeNull();
    // The crash frame is the headline only; a caller error that mentions it
    // inside its own diagnostic block is still a caller error.
    expect(
      toBrowserTargetCrashedError(new Error("page.evaluate: boom\nCall log:\n  - Target crashed")),
    ).toBeNull();
  });

  it("does not translate a page-script error into crash guidance", () => {
    const res = fakeResponse();

    handleRouteError(res as unknown as BrowserResponse, new Error("target crashed"));

    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  it("returns a 409 with new-tab guidance instead of browser-wide unavailability", () => {
    const res = fakeResponse();

    handleRouteError(res as unknown as BrowserResponse, new Error("page.route: Target crashed"));

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: new BrowserTargetCrashedError().message });
    expect(new BrowserTargetCrashedError().message).not.toContain("currently unavailable");
  });

  it("returns the same 409 when Playwright appends its diagnostic block", () => {
    const res = fakeResponse();

    handleRouteError(
      res as unknown as BrowserResponse,
      new Error("page.screenshot: Target crashed\nCall log:\n  - taking page screenshot"),
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: new BrowserTargetCrashedError().message });
  });
});
