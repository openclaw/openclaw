import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JsonSchemaValue } from "../plugins/schema-validator.js";
import type { CodeModeApiVirtualFile } from "./code-mode-mcp-api.js";
import { readToolOutputSchemaVariants } from "./schema/tool-output-schema.js";
import { MAX_TOOL_SCHEMA_DECLARATION_CHARS, toolSchemaDeclaration } from "./tool-schema-hints.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

/** Generate only on API.read, from the same effective schemas as describe(). */
export async function createCodeModeToolApiFile(
  callableName: string,
  entry: Pick<ToolSearchCatalogEntry, "source" | "parameters" | "outputSchema">,
): Promise<CodeModeApiVirtualFile> {
  const trusted = entry.source === "openclaw";
  const input = trusted ? toolSchemaDeclaration(entry.parameters) : "unknown";
  const variants = trusted ? readToolOutputSchemaVariants(entry.outputSchema) : undefined;
  let optional = false;
  if (trusted) {
    const { validateJsonSchemaValue } = await import("../plugins/schema-validator.js");
    try {
      optional = validateJsonSchemaValue({
        // SAFETY: The canonical validator checks the schema shape before compiling it.
        schema: (entry.parameters ?? {}) as JsonSchemaValue,
        value: {},
      }).ok;
    } catch {
      // Invalid or unsupported contracts must never advertise optional required input.
    }
  }
  const specialized = variants?.canNarrow
    ? createVariantDeclarations({
        callableName,
        input,
        optional,
        outputSchema: entry.outputSchema,
        variants,
      })
    : undefined;
  let declarations = specialized;
  if (!declarations) {
    const output = trusted ? toolSchemaDeclaration(entry.outputSchema) : "unknown";
    declarations = [
      ...(variants
        ? [
            variants.canNarrow
              ? "// Action declarations exceed the shared output allowance; using the complete union."
              : "// Reference-bearing or structurally complex schemas retain the complete output union.",
          ]
        : []),
      `declare function ${callableName}(input${optional ? "?" : ""}: ${input}): Promise<${output}>;`,
    ];
  }
  const content = [
    "// Generated from the effective tool contract. Unsupported shapes stay unknown.",
    "// JSON Schema validation owns constraints; describe() exposes the original schema.",
    "// Values enter the guest intact or reject when program-data admission is full.",
    ...declarations,
  ].join("\n");
  return {
    path: "tools/" + callableName + ".d.ts",
    content,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

type ObjectDeclaration = {
  name: string;
  properties: Record<string, unknown>;
  required: Set<string>;
};

function readObjectDeclaration(name: string, schema: unknown): ObjectDeclaration | undefined {
  if (
    !isRecord(schema) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isRecord(schema.properties) ||
    Object.keys(schema).some(
      (key) => !["type", "properties", "required", "additionalProperties"].includes(key),
    ) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every((key): key is string => typeof key === "string")))
  ) {
    return undefined;
  }
  const properties = schema.properties;
  const required = new Set<string>(schema.required ?? []);
  if ([...required].some((key) => !Object.hasOwn(properties, key))) {
    return undefined;
  }
  return { name, properties, required };
}

function createVariantDeclarations(params: {
  callableName: string;
  input: string;
  optional: boolean;
  outputSchema: ToolSearchCatalogEntry["outputSchema"];
  variants: NonNullable<ReturnType<typeof readToolOutputSchemaVariants>>;
}): string[] | undefined {
  const { callableName, input, optional, outputSchema, variants } = params;
  const declarations: string[] = [];
  let outputChars = 0;
  const append = (declaration: string, inputChars = 0): boolean => {
    outputChars += declaration.length + 1 - inputChars;
    if (outputChars > MAX_TOOL_SCHEMA_DECLARATION_CHARS) {
      return false;
    }
    declarations.push(declaration);
    return true;
  };
  const prefix = `__OpenClaw_${callableName}_`;
  const inputName = `${prefix}Input`;
  // Input keeps its original independent allowance and appears only once.
  if (!append(`type ${inputName} = ${input};`, input.length)) {
    return undefined;
  }
  const names: string[] = [];
  const objects: ObjectDeclaration[] = [];
  const reuseObjectDeclaration = (schema: unknown, rendered: string): string => {
    let output = rendered;
    const object = output === "unknown" ? undefined : readObjectDeclaration("", schema);
    if (!object) {
      return output;
    }
    // Extended results share already-declared fields without widening either contract.
    for (const base of objects) {
      if (
        !Object.entries(base.properties).every(
          ([key, value]) =>
            Object.hasOwn(object.properties, key) &&
            base.required.has(key) === object.required.has(key) &&
            isDeepStrictEqual(value, object.properties[key]),
        )
      ) {
        continue;
      }
      const properties = Object.fromEntries(
        Object.entries(object.properties).filter(([key]) => !Object.hasOwn(base.properties, key)),
      );
      const extension = toolSchemaDeclaration({
        ...outputSchema,
        anyOf: [
          {
            type: "object",
            properties,
            required: [...object.required].filter((key) => Object.hasOwn(properties, key)),
            additionalProperties: false,
          },
        ],
      });
      const factored =
        Object.keys(properties).length === 0 ? base.name : `${base.name} & ${extension}`;
      if (extension !== "unknown" && factored.length < output.length) {
        output = factored;
      }
    }
    return output;
  };
  for (const [index, schema] of variants.variants.entries()) {
    const name = `${prefix}Output${index}`;
    // Preserve root shape constraints; unsupported types stay unknown.
    const rendered = toolSchemaDeclaration({ ...outputSchema, anyOf: [schema] });
    let output = reuseObjectDeclaration(schema, rendered);
    if (
      rendered !== "unknown" &&
      isRecord(schema) &&
      Array.isArray(schema.anyOf) &&
      Object.keys(schema).every((key) => key === "anyOf")
    ) {
      const branches = schema.anyOf.map((branch) => ({
        schema: branch,
        rendered: toolSchemaDeclaration({ ...outputSchema, anyOf: [branch] }),
      }));
      // Branch isolation must not deepen knowledge lost to the original traversal bounds.
      if ([...new Set(branches.map((branch) => branch.rendered))].join(" | ") === rendered) {
        const factored = [
          ...new Set(
            branches.map((branch) => reuseObjectDeclaration(branch.schema, branch.rendered)),
          ),
        ].join(" | ");
        if (factored.length < output.length) {
          output = factored;
        }
      }
    }
    const object = rendered === "unknown" ? undefined : readObjectDeclaration(name, schema);
    if (object) {
      objects.push(object);
    }
    if (!append(`type ${name} = ${output};`)) {
      return undefined;
    }
    names.push(name);
  }
  const mappingName = `${prefix}OutputByInput`;
  if (!append(`type ${mappingName} = {`)) {
    return undefined;
  }
  for (const [value, index] of variants.mapping) {
    if (!append(`${JSON.stringify(value)}: ${names[index]};`)) {
      return undefined;
    }
  }
  if (!append("};")) {
    return undefined;
  }
  const fallback = names.join(" | ");
  if (
    !append(
      `declare function ${callableName}<const Input extends ${inputName}>(input: Input): Promise<Input extends { ${JSON.stringify(variants.inputProperty)}: infer Value } ? Value extends keyof ${mappingName} ? ${mappingName}[Value] : ${fallback} : ${fallback}>;`,
    ) ||
    !append(
      `declare function ${callableName}(input${optional ? "?" : ""}: ${inputName}): Promise<${fallback}>;`,
    )
  ) {
    return undefined;
  }
  return declarations;
}
