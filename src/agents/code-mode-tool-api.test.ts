import { Type } from "typebox";
import { expect, it } from "vitest";
import { typeCheckSources } from "../../test/helpers/typescript.js";
import { createCodeModeToolApiFile } from "./code-mode-tool-api.js";
import { defineToolOutputSchema } from "./schema/tool-output-schema.js";

it("preserves extended action results within the shared declaration allowance", async () => {
  const fields = {
    id: Type.String(),
    ...Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `field_${index}_${"x".repeat(85)}`,
        Type.String(),
      ]),
    ),
  };
  const file = await createCodeModeToolApiFile("records", {
    source: "openclaw",
    parameters: Type.Object({ action: Type.String() }),
    outputSchema: defineToolOutputSchema({
      inputProperty: "action",
      variants: {
        get: Type.Object(fields, { additionalProperties: false }),
        update: Type.Object(
          { ...structuredClone(fields), warning: Type.Optional(Type.String()) },
          { additionalProperties: false },
        ),
        warn: Type.Object({ ...fields, warning: Type.String() }, { additionalProperties: false }),
        numeric: Type.Object({ ...fields, id: Type.Number() }, { additionalProperties: false }),
      },
    }),
  });
  expect(
    typeCheckSources({
      "/records-consumer.ts": `${file.content}
async function consume() {
  const result = await records({ action: "get" });
  const id: string = result.id;
  // @ts-expect-error The ordinary result has no warning.
  result.warning;
  const updated = await records({ action: "update" });
  const optionalWarning: string | undefined = updated.warning;
  // @ts-expect-error A write may succeed without a warning.
  updated.warning.toUpperCase();
  const warned = await records({ action: "warn" });
  const warning: string = warned.warning;
  const numeric = await records({ action: "numeric" });
  const numericId: number = numeric.id;
  // @ts-expect-error The alternate result changes the inherited field type.
  const stringId: string = numeric.id;
}`,
    }),
  ).toEqual([]);
});

it("preserves requiredness and nullable roots when reusing object declarations", async () => {
  const fields = { id: Type.String(), label: Type.Optional(Type.String()) };
  const file = await createCodeModeToolApiFile("records", {
    source: "openclaw",
    parameters: Type.Object({ action: Type.String() }),
    outputSchema: structuredClone(
      defineToolOutputSchema({
        inputProperty: "action",
        variants: {
          get: Type.Object(fields, { additionalProperties: false }),
          optional: Type.Object(
            { ...fields, id: Type.Optional(fields.id), extra: Type.Boolean() },
            { additionalProperties: false },
          ),
          required: Type.Object(
            { ...fields, label: Type.String(), extra: Type.Boolean() },
            { additionalProperties: false },
          ),
          nullable: Type.Object(fields, { additionalProperties: false, nullable: true }),
        },
      }),
    ),
  });
  expect(
    typeCheckSources({
      "/records-consumer.ts": `${file.content}
async function consume() {
  const optional = await records({ action: "optional" });
  const id: string | undefined = optional.id;
  // @ts-expect-error The optional result can omit an inherited required field.
  optional.id.toUpperCase();
  const required = await records({ action: "required" });
  const label: string = required.label;
  const nullable = await records({ action: "nullable" });
  const absent: typeof nullable = null;
  // @ts-expect-error A nullable root cannot promise the inherited object.
  nullable.id;
}`,
    }),
  ).toEqual([]);
});
