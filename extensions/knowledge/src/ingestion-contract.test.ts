import { projectRuntimeToolInputSchema } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { normalizeOpenAIStrictCompatSchema } from "openclaw/plugin-sdk/provider-tools";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { BatchInput } from "./ingestion-contract.js";

const evidence = { path: "sources/meeting.txt", sha256: "a".repeat(64) };
const batch = (items: any) => ({
  requestId: "00000000-0000-0000-0000-000000000001",
  expectedVaultId: "00000000-0000-0000-0000-000000000002",
  expectedOntologyFingerprint: "a".repeat(64),
  items,
});
const page = {
  key: "meeting",
  kind: "page",
  input: { title: "Meeting", body: "Notes", attachments: [evidence] },
};
const claim = {
  key: "action",
  kind: "claim",
  input: {
    title: "Action",
    body: "Send report",
    claim_kind: "commitment",
    assertion_origin: "source",
    attribution: "Meeting",
    evidence: [evidence],
    owner: "@person",
    entities: ["@person"],
  },
};
const relationship = {
  key: "link",
  kind: "relationship",
  input: {
    title: "Attended",
    body: "Attended meeting",
    from: "@person",
    to: "@meeting",
    label: "attended",
    attribution: "Meeting",
    evidence: [evidence],
  },
};

it("batch schema retains closed, kind-specific inputs and nested evidence through host projection", () => {
  const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(BatchInput));
  expect(projected.violations).toStrictEqual([]);
  const accepts = (input: any) => {
    const local = Check(BatchInput, input);
    // The host projection of an object schema is itself a JSON-schema object.
    const schema = projected.schema as JsonSchemaObject;
    const host = validateJsonSchemaValue({ schema, value: input }).ok;
    expect(host, "host and backend validation must agree").toBe(local);
    return local;
  };
  const annotated = structuredClone({
    ...page,
    input: {
      ...page.input,
      identity: {
        status: "partial",
        context: "Two possible speakers",
        candidates: [{ id: "@person", basis: "Name", evidence: [evidence] }],
      },
      attribution_confidence: {
        level: "medium",
        basis: "Transcript",
        evidence: [evidence],
      },
      continuity: [{ id: "@prior", relation: "updates", basis: "New notes", evidence: [evidence] }],
      record_class: "fixture",
    },
  });
  expect(accepts(batch([annotated, claim, relationship]))).toBeTruthy();
  const emptyAttachments = structuredClone(page);
  emptyAttachments.input.attachments = [];
  expect(accepts(batch([emptyAttachments]))).toBeTruthy();
  // Each rejected shape is [item index, input path, replacement]; undefined deletes the field.
  for (const [index, field, value] of [
    [1, "claim_kind", undefined],
    [0, "owner", "@person"],
    [1, "evidence", []],
    [1, "owner", "@bad key"],
    [2, "from", 12],
    [0, "identity.candidates.0.evidence.0.sha256", "bad"],
    [0, "identity.candidates.0.id", "@bad key"],
    [0, "attribution_confidence.evidence", []],
    [0, "attribution_confidence.evidence", Array.from({ length: 21 }, () => evidence)],
    [0, "continuity.0.evidence", []],
    [0, "continuity.0.relation", "replaces"],
    [0, "requestId", "00000000-0000-0000-0000-000000000001"],
    [0, "source", { text: "inline", attribution: "source" }],
  ] as const) {
    const input = structuredClone(batch([annotated, claim, relationship]));
    const keys = field.split(".");
    const parent = keys.slice(0, -1).reduce((node, key) => node[key], input.items[index].input);
    if (value === undefined) {
      delete parent[keys.at(-1)!];
    } else {
      parent[keys.at(-1)!] = value;
    }
    expect(accepts(input), field).toBe(false);
  }
  const wrongKind = structuredClone(batch([annotated, claim, relationship]));
  wrongKind.items[0].kind = "claim";
  expect(accepts(wrongKind)).toBe(false);
});

// Codex's input schema projection retains these keywords and lowers const to
// enum before applying its 5,000-byte compaction threshold. An oversized schema
// loses $defs, then nested objects, hiding batch fields as Array<unknown>.
function codexShape(schema: any) {
  const result: any = {};
  // Installed Codex 0.155.1 retains minItems, unlike the older sibling checkout.
  for (const key of ["type", "enum", "required", "$ref", "minItems"]) {
    if (key in schema) {
      result[key] = schema[key];
    }
  }
  if ("const" in schema) {
    result.enum = [schema.const];
  }
  if (!result.type && result.enum && !result.$ref) {
    result.type = "string";
  }
  for (const key of ["properties", "$defs", "definitions"]) {
    if (schema[key]) {
      result[key] = Object.fromEntries(
        Object.entries(schema[key]).map(([name, child]) => [name, codexShape(child)]),
      );
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (schema[key]) {
      result[key] = schema[key].map(codexShape);
    }
  }
  if (schema.items) {
    result.items = codexShape(schema.items);
  }
  if ("additionalProperties" in schema) {
    result.additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : codexShape(schema.additionalProperties);
  }
  if (result.type === "object") {
    result.properties ??= {};
  }
  return result;
}

it("projected batch schema stays below the host compaction budget with resolvable shared definitions", () => {
  const { schema } = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(BatchInput));
  const projected = codexShape(schema);
  const bytes = Buffer.byteLength(JSON.stringify(projected));
  expect(bytes <= 5000, `batch schema would be compacted (${bytes} bytes)`).toBeTruthy();
  let references = 0;
  const expand = (node: any): any => {
    if (node.$ref) {
      references++;
      expect(node.$ref).toMatch(/^#\/\$defs\/\w+$/);
      const target = projected.$defs[node.$ref.split("/").at(-1)];
      expect(target, `unresolved ${node.$ref}`).toBeTruthy();
      const { $ref: _ref, ...siblings } = node;
      return { ...expand(target), ...siblings };
    }
    if (Array.isArray(node)) {
      return node.map(expand);
    }
    if (!node || typeof node !== "object") {
      return node;
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "$defs")
        .map(([key, value]) => [key, expand(value)]),
    );
  };
  const expanded = expand(projected);
  expect(
    references <= 32,
    `exceeds code-mode reference expansion budget (${references})`,
  ).toBeTruthy();
  const kinds = expanded.properties.items.items.anyOf;
  expect(kinds.map((kind: any) => kind.properties.kind.enum[0])).toStrictEqual([
    "page",
    "claim",
    "relationship",
  ]);
  expect(kinds[1].properties.input.required.includes("claim_kind")).toBeTruthy();
  expect(kinds[2].properties.input.properties.from.type).toBe("string");
  expect(kinds[0].properties.input.properties.attachments.items.properties.sha256.type).toBe(
    "string",
  );
  expect(kinds[0].properties.input.properties.attachments.minItems).toBe(undefined);
  expect(kinds[1].properties.input.properties.evidence.minItems).toBe(1);
  expect(kinds[1].properties.input.properties.evidence.items.properties.sha256.type).toBe("string");
});
