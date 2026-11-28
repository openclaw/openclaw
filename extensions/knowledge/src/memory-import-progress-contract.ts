import { Type } from "typebox";

const MemoryImportPath = Type.String({
  pattern: "^(?:MEMORY\\.md|DREAMS\\.md|memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md)$",
});
const MemoryImportFile = Type.Object(
  { path: MemoryImportPath, sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
const MemoryImportCheckFile = Type.Object(
  { path: MemoryImportPath, sha256: Type.Optional(MemoryImportFile.properties.sha256) },
  { additionalProperties: false },
);

export const MemoryImportProgressInput = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("check"),
      files: Type.Array(MemoryImportCheckFile, { minItems: 1, maxItems: 100 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("complete"), file: MemoryImportFile },
    { additionalProperties: false },
  ),
]);
export const MemoryImportProgressOutput = Type.Object({
  files: Type.Optional(Type.Array(MemoryImportCheckFile, { maxItems: 100 })),
  completed: Type.Array(MemoryImportPath, { maxItems: 100 }),
});
