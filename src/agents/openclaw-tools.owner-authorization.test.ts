import { describe, expect, it } from "vitest";
import {
  isOpenClawOwnerOnlyCoreToolName,
  OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES,
} from "./tools/owner-only-tools.js";

describe("createOpenClawTools owner authorization", () => {
  it("marks owner-only core tool names", () => {
    expect(OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES).toEqual(["cron", "gateway", "nodes"]);
    expect(isOpenClawOwnerOnlyCoreToolName("cron")).toBe(true);
    expect(isOpenClawOwnerOnlyCoreToolName("gateway")).toBe(true);
    expect(isOpenClawOwnerOnlyCoreToolName("nodes")).toBe(true);
  });

  it("keeps canvas non-owner-only", () => {
    expect(isOpenClawOwnerOnlyCoreToolName("canvas")).toBe(false);
  });
});
