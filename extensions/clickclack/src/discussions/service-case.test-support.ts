import { expect } from "vitest";
import { createHarness } from "./service-test-support.js";

type Harness = ReturnType<typeof createHarness>;
export async function opened(sessionKey: string, entry: Parameters<typeof createHarness>[0]) {
  const h = createHarness(entry);
  await h.service.open(sessionKey);
  return h;
}
export function expectCreated(h: Harness, fields: Record<string, unknown>) {
  expect(h.createChannel).toHaveBeenCalledWith("wsp_team", expect.objectContaining(fields));
}
export function expectPatched(h: Harness, fields: Record<string, unknown>, id = "chn_discussion") {
  expect(h.updateChannel).toHaveBeenCalledWith(id, expect.objectContaining(fields));
}
export function expectLastPatch(h: Harness, fields: Record<string, unknown>) {
  expect(h.updateChannel).toHaveBeenLastCalledWith("chn_discussion", fields);
}
