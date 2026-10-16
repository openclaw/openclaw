import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { EnvironmentSummarySchema } from "./environments.js";

describe("pre-device-folder protocol compatibility", () => {
  it("accepts an older node advertisement without inventing folder support", () => {
    const previousNode = {
      id: "node:previous-host",
      type: "node",
      status: "available",
      workerSlots: { total: 2, available: 1 },
    };
    const decoded = Value.Parse(EnvironmentSummarySchema, previousNode);
    expect(decoded).toEqual(previousNode);
    expect(decoded.workerHost).toBeUndefined();
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...previousNode,
        workerHost: { deviceFolders: true },
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...previousNode,
        workerHost: { deviceFolders: "true" },
      }),
    ).toBe(false);
  });
});
