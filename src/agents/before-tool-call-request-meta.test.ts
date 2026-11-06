import { describe, expect, it } from "vitest";
import {
  getBeforeToolCallRequestMeta,
  runWithHookAuthoredMeta,
} from "./before-tool-call-request-meta.js";

const stamp = { brayer: { harness: "h1", agent: "main", session: "s1" } };

/** The private diff is only observable through the public run-and-read contract. */
const resolve = (before: unknown, after: unknown) =>
  runWithHookAuthoredMeta(before, after, () => getBeforeToolCallRequestMeta());

describe("hook-authored request meta", () => {
  it("returns _meta the pipeline added where the hook input had none", () => {
    expect(resolve({ folder: "team" }, { folder: "team", _meta: stamp })).toEqual(stamp);
  });

  it("returns _meta the pipeline changed relative to the hook input", () => {
    expect(resolve({ _meta: { revision: 7 } }, { _meta: stamp })).toEqual(stamp);
  });

  it("does not promote _meta that passed through unchanged", () => {
    expect(resolve({ _meta: { revision: 7 } }, { _meta: { revision: 7 } })).toBeUndefined();
    const shared = { revision: 7 };
    expect(resolve({ _meta: shared }, { _meta: shared })).toBeUndefined();
  });

  it("does not promote when neither side carries _meta", () => {
    expect(resolve({ folder: "team" }, { folder: "team" })).toBeUndefined();
  });

  it("does not promote when the output carries no object _meta", () => {
    expect(resolve({ _meta: stamp }, { folder: "team" })).toBeUndefined();
    expect(resolve({ folder: "team" }, { folder: "team", _meta: "not-a-record" })).toBeUndefined();
  });

  it("does not promote when the output is not a record", () => {
    expect(resolve({ _meta: stamp }, undefined)).toBeUndefined();
    expect(resolve({ _meta: stamp }, "params")).toBeUndefined();
  });

  it("shadows an outer scope so a nested execution never inherits stale meta", () => {
    const nested = runWithHookAuthoredMeta({}, { _meta: stamp }, () =>
      runWithHookAuthoredMeta({}, {}, () => getBeforeToolCallRequestMeta()),
    );
    expect(nested).toBeUndefined();
  });

  it("restores the previous scope after the run", () => {
    const before = getBeforeToolCallRequestMeta();
    runWithHookAuthoredMeta({}, { _meta: stamp }, () => undefined);
    expect(getBeforeToolCallRequestMeta()).toBe(before);
  });

  it("reads undefined outside any scope", () => {
    expect(getBeforeToolCallRequestMeta()).toBeUndefined();
  });
});
