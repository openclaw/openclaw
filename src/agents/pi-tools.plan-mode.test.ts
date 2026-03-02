import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("pi-tools plan read-only mode", () => {
  it("keeps read-only tools and removes mutating tools when plan mode is on", () => {
    const tools = createOpenClawCodingTools({ readOnlyPlanMode: true });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("read")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);

    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("exec")).toBe(false);
    expect(names.has("message")).toBe(false);
    expect(names.has("sessions_send")).toBe(false);
  });

  it("keeps mutating tools when plan mode is off", () => {
    const tools = createOpenClawCodingTools({ readOnlyPlanMode: false });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(true);
  });
});
