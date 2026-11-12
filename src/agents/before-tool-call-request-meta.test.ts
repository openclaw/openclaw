import { describe, expect, it } from "vitest";
import {
  getBeforeToolCallRequestMeta,
  runWithHookAuthoredMeta,
} from "./before-tool-call-request-meta.js";

const stamp = { brayer: { harness: "h1", agent: "main", session: "s1" } };

describe("hook-authored request meta", () => {
  it("shadows an outer scope so a nested execution never inherits stale meta", () => {
    const nested = runWithHookAuthoredMeta(stamp, () =>
      runWithHookAuthoredMeta(undefined, () => getBeforeToolCallRequestMeta()),
    );
    expect(nested).toBeUndefined();
  });

  it("restores the previous scope after the run", () => {
    const before = getBeforeToolCallRequestMeta();
    runWithHookAuthoredMeta(stamp, () => undefined);
    expect(getBeforeToolCallRequestMeta()).toBe(before);
  });
});
