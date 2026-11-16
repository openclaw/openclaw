import type { TObject } from "typebox";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { buildKnowledgeMemoryPrompt } from "./memory-prompt.js";
import { RememberItem } from "./remember-contract.js";

const prompt = (tools: string[]) =>
  buildKnowledgeMemoryPrompt({ availableTools: new Set(tools) } as never).join("\n");

// Named keys of one object literal in a call shape; "?" marks optional ones.
function shapeKeys(shape: string) {
  const keys = [...shape.replaceAll(/"[^"]*"/gu, "").matchAll(/(\w+)(\??)(?=\s*[:,}])/gu)];
  return {
    all: keys.map((match) => match[1]!),
    required: keys.filter((match) => !match[2]).map((match) => match[1]!),
  };
}

function expectShapeMatches(shape: string, schema: TObject, impliedRequired: string[] = []) {
  const { all, required } = shapeKeys(shape);
  expect(all.filter((key) => !Object.hasOwn(schema.properties, key))).toStrictEqual([]);
  expect((schema.required ?? []).filter((key) => !required.includes(key))).toStrictEqual([]);
  expect(required.filter((key) => !schema.required?.includes(key))).toStrictEqual(impliedRequired);
}

it("prompt call shapes match the knowledge tool schemas", () => {
  const ops = contract.operations;
  const text = prompt(["knowledge_grep", "knowledge_lookup", "knowledge_remember"]);
  const remember = text.match(/knowledge_remember\(\{.*?\}\] \}\)/u)?.[0];
  const [outer, item] = remember!.split(/\[\{|\}\]/u) as [string, string];
  // requestId is optional only for the host pre-compaction flush, which agents never run.
  expectShapeMatches(`${outer}}`, ops.remember.input as TObject, ["requestId"]);
  expectShapeMatches(item, RememberItem);
  expect([...item.matchAll(/"([^"]+)"/gu)].map((match) => match[1])).toStrictEqual(
    RememberItem.properties.kind.anyOf.map((kind: { const: string }) => kind.const),
  );
  for (const op of [ops.lookup, ops.grep]) {
    const shapes = text.match(new RegExp(`${op.tool!.name}\\(\\{[^}]*\\}\\)`, "gu"));
    expect(shapes).toHaveLength(1);
    expectShapeMatches(shapes![0]!, op.input as TObject);
  }
});

it("prompt shows each call shape only with its tool", () => {
  expect(prompt(["knowledge_grep"])).not.toMatch(/knowledge_(lookup|remember)\(/u);
  expect(prompt(["knowledge_lookup"])).toMatch(/knowledge_lookup\(\{ query \}\)/u);
  expect(prompt(["knowledge_lookup"])).not.toMatch(/knowledge_(grep|remember)\(/u);
});
