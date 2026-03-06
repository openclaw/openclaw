import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "./schema-utils.js";

const DRIVE_ACTIONS = [
  "list",
  "info",
  "create_folder",
  "move",
  "delete",
  "upload",
  "import",
] as const;

export type FeishuDriveAction = (typeof DRIVE_ACTIONS)[number];

const FILE_TYPES = [
  "doc",
  "docx",
  "sheet",
  "bitable",
  "folder",
  "file",
  "mindnote",
  "shortcut",
] as const;

export const FeishuDriveSchema = Type.Object({
  action: stringEnum(DRIVE_ACTIONS, {
    description: "Action to perform: list/info/create_folder/move/delete/upload/import",
  }),
  folder_token: Type.Optional(
    Type.String({
      description:
        "Folder token (for list: parent folder; for create_folder: parent; for move: target folder; for upload: parent folder)",
    }),
  ),
  file_token: Type.Optional(
    Type.String({
      description: "File or folder token (required for info/move/delete/import)",
    }),
  ),
  type: Type.Optional(
    stringEnum(FILE_TYPES, {
      description: "File type (required for info/move/delete)",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Folder name (required for create_folder)" })),
  file_name: Type.Optional(
    Type.String({
      description: "File name (required for upload; optional for import)",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Text content to upload as file (required for upload when no file_path)",
    }),
  ),
  file_extension: Type.Optional(
    Type.String({
      description:
        'Source file extension for import (required for import, e.g. "md", "docx", "csv")',
    }),
  ),
  target_type: Type.Optional(
    Type.String({
      description:
        'Target Feishu document type for import (required for import, e.g. "docx", "sheet")',
    }),
  ),
});

export type FeishuDriveParams = Static<typeof FeishuDriveSchema>;
