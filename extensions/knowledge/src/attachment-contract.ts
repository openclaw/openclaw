import { Type, type Static } from "typebox";
import { text, Evidence } from "./model.js";

const uuid = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
// Preserve the upload limit for existing clients and replayed upload chunks.
export const ATTACHMENT_CHUNK_BYTES = 48 * 1024;
// Downloads also need room for metadata and the tool-result JSON envelope
// beneath the dynamic transport's 64,000-character response budget.
export const ATTACHMENT_DOWNLOAD_CHUNK_BYTES = 32 * 1024;
export const AttachInput = Type.Object(
  {
    requestId: Type.String({
      ...uuid,
      description:
        "Generate a lowercase UUID per original file (not a title or source ID); reuse it for all chunks and exact retries of that file only.",
    }),
    expectedVaultId: Type.Optional(uuid),
    filename: Type.String({ minLength: 1, maxLength: 200, pattern: "^[^/\\\\\\x00-\\x1f]+$" }),
    mediaType: Type.Optional(text(200)),
    attribution: Type.String({ minLength: 1, maxLength: 1000 }),
    offset: Type.Integer({ minimum: 0 }),
    data: text(65536),
    final: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AttachInput = Static<typeof AttachInput>;
export const AttachFileInput = Type.Object(
  {
    ...Type.Omit(AttachInput, ["offset", "data", "final"]).properties,
    filePath: Type.String({ minLength: 1, maxLength: 4096 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
export type AttachFileInput = Static<typeof AttachFileInput>;
export const AttachOutput = Type.Object(
  {
    requestId: uuid,
    state: Type.Union([Type.Literal("uploading"), Type.Literal("complete")]),
    receivedBytes: Type.Integer({ minimum: 0 }),
    evidence: Type.Optional(Evidence),
  },
  { additionalProperties: false },
);
export type AttachOutput = Static<typeof AttachOutput>;
export const AttachmentInput = Type.Object(
  {
    id: text(96),
    path: text(500),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export const AttachmentOutput = Type.Object(
  {
    filename: text(200),
    mediaType: text(200),
    sha256: text(64),
    size: Type.Integer(),
    offset: Type.Integer(),
    data: text(65536),
    nextOffset: Type.Union([Type.Integer(), Type.Null()]),
  },
  { additionalProperties: false },
);
