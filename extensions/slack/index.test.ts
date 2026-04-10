import { beforeAll, describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

let entry: typeof import("./index.js").default;

describe("slack bundled entries", () => {
  beforeAll(async () => {
    ({ default: entry } = await import("./index.js"));
  });

  it("declares the channel plugin without importing the broad api barrel", () => {
    expect(entry.kind).toBe("bundled-channel-entry");
    expect(entry.id).toBe("slack");
    expect(entry.name).toBe("Slack");
  });

  it("declares the setup plugin without importing the broad api barrel", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
