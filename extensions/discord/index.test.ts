import { expect, it, vi } from "vitest";

// mock-isolation: Import failure proves inspection never loads the activity runtime.
vi.mock("./activities-api.js", () => {
  throw new Error("activity runtime must not load during account inspection");
});
// mock-isolation: Import failure proves inspection never loads the voice runtime.
vi.mock("./transcripts-source-api.js", () => {
  throw new Error("voice runtime must not load during account inspection");
});

it("inspects account configuration without activity or voice runtime availability", async () => {
  const { default: entry } = await import("./index.js");
  const inspect = entry.loadChannelAccountInspector;
  expect(inspect).toBeDefined();
  expect(inspect?.()({ channels: { discord: { token: "inspection-only-token" } } })).toMatchObject({
    accountId: "default",
    configured: true,
    tokenSource: "config",
  });
});
