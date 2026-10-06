import { expect, it, vi } from "vitest";
import * as runtime from "./channel.runtime.js";

vi.mock("./mattermost/monitor.js", () => {
  throw new Error("Mattermost send runtime must not import the inbound monitor");
});

it("loads outbound operations without starting the inbound monitor module", () => {
  expect(runtime.sendMessageMattermost).toBeTypeOf("function");
  expect(runtime.resolveMattermostOpaqueTarget).toBeTypeOf("function");
});
