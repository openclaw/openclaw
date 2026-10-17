import { expect } from "vitest";

type GateableTool = {
  name: string;
  execute: (...args: never[]) => Promise<{ content?: unknown; details?: unknown }>;
};

/**
 * Asserts each named tool keeps its definition but this turn may not run it.
 * An absent tool is also not callable (another policy removed it).
 */
export async function expectOwnerGated(tools: readonly GateableTool[], ...names: string[]) {
  for (const name of names) {
    await expectGated(tools, name, `${name} needs the owner's authority`);
  }
}

export async function expectGated(tools: readonly GateableTool[], name: string, reason: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return;
  }
  const execute = tool.execute as (id: string, args: object) => ReturnType<GateableTool["execute"]>;
  const result = await execute(`gated-${name}`, {});
  expect(result.details).toMatchObject({ gated: true });
  expect(JSON.stringify(result.content)).toContain(reason);
}
