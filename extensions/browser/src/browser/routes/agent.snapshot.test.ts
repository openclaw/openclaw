// Browser tests cover agent.snapshot plugin behavior.
import { describe, expect, it } from "vitest";
import {
  readChromeMcpOperationTargetId,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";

describe("resolveOperationTargetOutcome", () => {
  it("returns the acted-on target when the backend reports no operation-owned id", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: null,
      }),
    ).toBe("old-123");
  });

  it("returns the acted-on target when the backend reports an empty operation-owned id", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "   ",
      }),
    ).toBe("old-123");
  });

  it("returns the backend operation-owned target when provided", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "fresh-456",
      }),
    ).toBe("fresh-456");
  });

  it("never adopts a tab from list inference; stale acted-on id is kept when page closes", () => {
    // Regression for #103785: after an action closes the acted-on page, route
    // code must not infer a replacement from tab lists or unrelated survivors.
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "acted-on-a",
        operationTargetId: undefined,
      }),
    ).toBe("acted-on-a");
  });

  it("preserves renderer-swap continuity via backend page identity", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-renderer",
        operationTargetId: "reattached-renderer",
      }),
    ).toBe("reattached-renderer");
  });
});

describe("readChromeMcpOperationTargetId", () => {
  it("returns the acted-on target when it is still present in the tab list", async () => {
    await expect(
      readChromeMcpOperationTargetId({
        actedOnTargetId: "tab-a",
        listTabs: async () => [{ targetId: "tab-a" }, { targetId: "tab-b" }],
      }),
    ).resolves.toBe("tab-a");
  });

  it("returns null when the acted-on target is gone from the tab list", async () => {
    await expect(
      readChromeMcpOperationTargetId({
        actedOnTargetId: "tab-a",
        listTabs: async () => [{ targetId: "tab-b" }],
      }),
    ).resolves.toBeNull();
  });

  it("does not adopt a different tab when the acted-on target is gone", async () => {
    const outcome = resolveOperationTargetOutcome({
      actedOnTargetId: "tab-a",
      operationTargetId: await readChromeMcpOperationTargetId({
        actedOnTargetId: "tab-a",
        listTabs: async () => [{ targetId: "tab-b" }],
      }),
    });
    expect(outcome).toBe("tab-a");
  });

  it("does not adopt a sole unrelated survivor when the acted-on target is gone", async () => {
    const soleSurvivorTabs = [{ targetId: "unrelated-b" }];
    const operationTargetId = await readChromeMcpOperationTargetId({
      actedOnTargetId: "acted-on-a",
      listTabs: async () => soleSurvivorTabs,
    });
    expect(operationTargetId).toBeNull();
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "acted-on-a",
        operationTargetId,
      }),
    ).toBe("acted-on-a");
  });
});
