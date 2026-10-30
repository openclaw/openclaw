import { Type } from "typebox";
import { executionTitleSchema } from "../../schema/typebox.js";

export const bashSchema = Type.Object({
  title: executionTitleSchema(),
  command: Type.String({ description: "Bash command." }),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout seconds; default none." })),
});

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description: "Exact original text; unique and non-overlapping in this call.",
    }),
    newText: Type.String({ description: "Replacement text." }),
  },
  {},
);

export const editSchema = Type.Object(
  {
    path: Type.String({ description: "File path; relative/absolute." }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "Targeted replacements against original file; no overlap/nesting. Merge nearby changes.",
    }),
  },
  {},
);

export const EditToolOutputSchema = Type.Union([
  Type.Object({ changed: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object(
    {
      changed: Type.Literal(true),
      diff: Type.String(),
      patch: Type.String(),
      firstChangedLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
]);

export const findSchema = Type.Object({
  pattern: Type.String({ description: "File glob, e.g. **/*.ts." }),
  path: Type.Optional(Type.String({ description: "Search dir; default cwd." })),
  limit: Type.Optional(Type.Integer({ description: "Max results; default 1000." })),
});

export const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regex/literal pattern." }),
  path: Type.Optional(Type.String({ description: "File/dir; default cwd." })),
  glob: Type.Optional(Type.String({ description: "File glob, e.g. *.ts." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Ignore case; default false." })),
  literal: Type.Optional(Type.Boolean({ description: "Literal, not regex; default false." })),
  context: Type.Optional(Type.Number({ description: "Context lines each side; default 0." })),
  limit: Type.Optional(Type.Number({ description: "Max matches; default 100." })),
});

export const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory; default cwd." })),
  limit: Type.Optional(Type.Number({ description: "Max entries; default 500." })),
  after: Type.Optional(
    Type.String({ description: "Filename cursor returned by the previous page." }),
  ),
});

const readContinuationFields = {
  offset: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
};

export const ReadToolContinuationSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("line"), ...readContinuationFields },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cursor"),
      ...readContinuationFields,
      cursor: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
]);

export const readToolInputSchema = Type.Object({
  path: Type.String({ description: "File path; relative/absolute." }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Start line; 1-based." })),
  limit: Type.Optional(Type.Number({ description: "Max lines." })),
  cursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "Character position within the start line; 0-based." }),
  ),
  optional: Type.Optional(
    Type.Literal(true, {
      description: "Missing paths return structured not_found instead of failing.",
    }),
  ),
});

export const readTruncationOutputSchema = Type.Object(
  {
    truncated: Type.Literal(true),
    truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes")]),
    totalLines: Type.Integer({ minimum: 0 }),
    totalBytes: Type.Integer({ minimum: 0 }),
    outputLines: Type.Integer({ minimum: 0 }),
    outputBytes: Type.Integer({ minimum: 0 }),
    lastLinePartial: Type.Boolean(),
    firstLineExceedsLimit: Type.Boolean(),
    maxLines: Type.Integer({ minimum: 1 }),
    maxBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const readToolOutputSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("text"), content: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("image"), content: Type.String(), mimeType: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("truncated"),
      content: Type.String(),
      truncation: readTruncationOutputSchema,
      continuation: ReadToolContinuationSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("not_found"),
      status: Type.Literal("not_found"),
      path: Type.String(),
      optional: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
]);

export const writeSchema = Type.Object({
  path: Type.String({ description: "File path; relative/absolute." }),
  content: Type.String({ description: "File content." }),
});

export const WriteToolOutputSchema = Type.Union([
  Type.Object({ changed: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object(
    {
      changed: Type.Literal(true),
      created: Type.Literal(true),
      diff: Type.String(),
      patch: Type.String(),
      firstChangedLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      changed: Type.Literal(true),
      created: Type.Literal(false),
      diff: Type.String(),
      patch: Type.String(),
      firstChangedLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { changed: Type.Literal(true), created: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
]);
