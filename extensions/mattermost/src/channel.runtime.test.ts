import { expect, it, vi } from "vitest";

vi.mock("./mattermost/monitor.js", () => {
  throw new Error("Mattermost send runtime must not import the inbound monitor");
});

it("loads outbound operations without starting the inbound monitor module", async () => {
  const runtime = await import("./channel.runtime.js");
  expect(runtime.sendMessageMattermost).toBeTypeOf("function");
  expect(runtime.resolveMattermostOpaqueTarget).toBeTypeOf("function");
});
