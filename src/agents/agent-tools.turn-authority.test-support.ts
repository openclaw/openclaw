import { expect } from "vitest";
import { getAgentToolExecutionLocation } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Asserts each named tool keeps its definition but this turn may not run it.
 * An absent tool is also not callable (another policy removed it).
 */
export async function expectOwnerGated(tools: readonly AnyAgentTool[], ...names: string[]) {
  for (const name of names) {
    await expectGated(tools, name, `${name} needs the owner's authority`);
  }
}

async function expectGated(tools: readonly AnyAgentTool[], name: string, reason: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return;
  }
  // A worker placement sends the call to the Gateway, which returns the refusal.
  expect(getAgentToolExecutionLocation(tool).kind).toBe("gateway");
  const result = await tool.execute(`gated-${name}`, {});
  expect(result.details).toMatchObject({ gated: true });
  expect(JSON.stringify(result.content)).toContain(reason);
}

export async function expectSenderGated(tools: readonly AnyAgentTool[], ...names: string[]) {
  for (const name of names) {
    await expectGated(tools, name, `${name} is not allowed for the sender of this message`);
  }
}
