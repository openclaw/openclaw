/** Tests bootstrap mode selection for primary, automation, and sandboxed runs. */
import { describe, expect, it } from "vitest";
import { resolveBootstrapMode } from "./bootstrap-mode.js";

describe("resolveBootstrapMode", () => {
  const primaryRun = {
    bootstrapPending: true,
    runKind: "default",
    isInteractiveUserFacing: true,
    isPrimaryRun: true,
    isCanonicalWorkspace: true,
    hasBootstrapFileAccess: true,
  } as const;

  it("returns none when bootstrap is not pending", () => {
    expect(resolveBootstrapMode({ ...primaryRun, bootstrapPending: false })).toBe("none");
  });

  it("returns full for primary interactive canonical runs with file access", () => {
    expect(resolveBootstrapMode(primaryRun)).toBe("full");
  });

  it("returns limited for primary interactive copied-sandbox runs with file access", () => {
    expect(resolveBootstrapMode({ ...primaryRun, isCanonicalWorkspace: false })).toBe("limited");
  });

  it("returns none for background and non-primary runs", () => {
    expect(resolveBootstrapMode({ ...primaryRun, runKind: "cron" })).toBe("none");
    expect(resolveBootstrapMode({ ...primaryRun, isPrimaryRun: false })).toBe("none");
  });

  it("returns limited when the run cannot access bootstrap files normally", () => {
    expect(resolveBootstrapMode({ ...primaryRun, hasBootstrapFileAccess: false })).toBe("limited");
  });
});
