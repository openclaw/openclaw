import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { SkillLibraryFileSchema } from "./skill-library.js";

export const SkillLibraryWorkshopSchema = closedObject({
  action: Type.Enum(
    [
      "list",
      "read",
      "create",
      "update",
      "share",
      "unshare",
      "transfer",
      "activate",
      "remove",
      "rollback",
    ] as const,
    { type: "string" },
  ),
  target: Type.Optional(Type.Literal("personal")),
  skill_id: Type.Optional(Type.String({ maxLength: 36 })),
  expected_revision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  revision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  name: Type.Optional(
    Type.String({
      maxLength: 63,
      description:
        "Human-facing slug, not the generated command name. Omit on update to preserve it.",
    }),
  ),
  proposal_content: Type.Optional(Type.String({ maxLength: 32768 })),
  artifact_path: Type.Optional(
    Type.String({
      maxLength: 512,
      description:
        "Read one whole UTF-8 artifact; defaults to SKILL.md. Binary or oversized files require the UI or CLI.",
    }),
  ),
  files: Type.Optional(
    Type.Array(
      closedObject({
        ...SkillLibraryFileSchema.properties,
        content: Type.String({ maxLength: 32768 }),
      }),
      {
        maxItems: 32,
        description:
          "Named support-file upserts. Other files and omitted executable flags are preserved.",
      },
    ),
  ),
  delete_files: Type.Optional(
    Type.Array(Type.String({ maxLength: 512 }), {
      maxItems: 32,
      description: "Exact supporting paths to remove intentionally; never SKILL.md.",
    }),
  ),
});
