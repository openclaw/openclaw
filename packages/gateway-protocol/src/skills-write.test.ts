import { describe, expect, it } from "vitest";
import {
  validateSkillsWriteApplyProposalParams,
  validateSkillsWriteDirectParams,
  validateSkillsWriteProposeParams,
  validateSkillsWriteRefreshSnapshotParams,
  validateSkillsWriteValidateParams,
} from "./index.js";

describe("skills write protocol validators", () => {
  it("accepts each request shape and rejects invalid variants", () => {
    const content = "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n";
    expect(validateSkillsWriteValidateParams({ name: "demo", content })).toBe(true);
    expect(validateSkillsWriteValidateParams({ name: "demo", content, unexpected: true })).toBe(
      false,
    );
    expect(
      validateSkillsWriteProposeParams({
        kind: "create",
        name: "demo",
        description: "Demo skill",
        content: "# Demo\n",
      }),
    ).toBe(true);
    expect(
      validateSkillsWriteProposeParams({
        kind: "update",
        skillName: "demo",
        content: "# Updated demo\n",
      }),
    ).toBe(true);
    expect(
      validateSkillsWriteProposeParams({
        kind: "create",
        name: "demo",
        content: "# Missing description\n",
      }),
    ).toBe(false);
    expect(
      validateSkillsWriteDirectParams({
        mode: "create",
        name: "demo",
        content,
        refresh: false,
      }),
    ).toBe(true);
    expect(validateSkillsWriteDirectParams({ mode: "replace", name: "demo", content })).toBe(false);
    expect(validateSkillsWriteApplyProposalParams({ proposalId: "proposal-1" })).toBe(true);
    expect(validateSkillsWriteRefreshSnapshotParams({})).toBe(true);
  });
});
