import { describe, expect, it } from "vitest";
import {
  checkRobotConstitution,
  parseRobotConstitutionFromMd,
  capabilityForPlaybookAction,
} from "./robot-constitution.js";

describe("robot-constitution", () => {
  it("parses fenced constitution yaml", () => {
    const md = `# Robot
\`\`\`yaml constitution
auto_allow:
  - notify
deny:
  - delete.*
hitl_required:
  - create.work_order
\`\`\``;
    const c = parseRobotConstitutionFromMd(md);
    expect(c.autoAllow).toContain("notify");
    expect(c.deny).toContain("delete.*");
    expect(c.hitlRequired).toContain("create.work_order");
  });

  it("denies delete capabilities", () => {
    const c = parseRobotConstitutionFromMd("");
    const result = checkRobotConstitution(c, "delete.work_order");
    expect(result.decision).toBe("deny");
  });

  it("maps create_work_order action", () => {
    expect(capabilityForPlaybookAction("create_work_order")).toBe("create.work_order");
  });

  it("merges custom trusted_sources with defaults", () => {
    const md = `# Robot
\`\`\`yaml constitution
trusted_sources:
  - custom_integration
\`\`\``;
    const c = parseRobotConstitutionFromMd(md);
    expect(c.trustedSources).toContain("custom_integration");
    expect(c.trustedSources).toContain("im-bridge");
  });

  it("requires HITL for constitution hitl_required capabilities", () => {
    const c = parseRobotConstitutionFromMd("");
    const result = checkRobotConstitution(c, "create.work_order");
    expect(result.decision).toBe("hitl_required");
  });
});
