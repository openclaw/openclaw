import { describe, expect, it } from "vitest";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

function findToolDescription(toolName: string, senderIsOwner: boolean) {
  const tools = createOpenClawCodingTools({ senderIsOwner });
  const tool = tools.find((entry) => entry.name === toolName);
  return {
    toolNames: tools.map((entry) => entry.name),
    description: tool?.description ?? "",
  };
}

describe("createOpenClawCodingTools deferred follow-up guidance", () => {
  it("keeps cron-specific guidance when cron survives filtering", () => {
    const exec = findToolDescription("exec", true);
    const process = findToolDescription("process", true);

    expect(exec.toolNames).toContain("cron");
    expect(exec.description).toContain("use cron instead");
    expect(process.description).toContain("use cron for scheduled follow-ups");
  });

  it("drops cron-specific guidance when cron is unavailable", () => {
    const exec = findToolDescription("exec", false);
    const process = findToolDescription("process", false);

    expect(exec.toolNames).not.toContain("cron");
    expect(exec.description).not.toContain("use cron instead");
    expect(process.description).not.toContain("use cron for scheduled follow-ups");
  });
});
