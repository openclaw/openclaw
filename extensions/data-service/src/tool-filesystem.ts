/**
 * Filesystem tools for project virtual disk (S3-backed).
 *
 * These tools provide standard filesystem operations that are automatically
 * scoped to the current project's isolated storage at s3://{bucket}/{orgId}/{projectId}/
 *
 * All tools require:
 * - User context (orgId, userId) set via data-service.setContext
 * - Project context (projectId) set via data-service.setContext
 * - S3 configuration enabled
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import type { DataServiceConfig, S3Config } from "./config.js";
import { hasFilesystemContext, getEffectiveUserContext, MISSING_PROJECT_ERROR } from "./config.js";
import {
  s3ReadFile,
  s3WriteFile,
  s3DeleteFile,
  s3List,
  s3Mkdir,
  s3Rmdir,
  s3Exists,
  s3Stat,
} from "./s3-client.js";
import {
  FsReadSchema,
  FsWriteSchema,
  FsEditSchema,
  FsDeleteSchema,
  FsListSchema,
  FsMkdirSchema,
  FsRmdirSchema,
  FsExistsSchema,
  FsStatSchema,
} from "./schemas.js";

/**
 * Helper to read a boolean parameter from tool args.
 */
function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "no") {
      return false;
    }
  }
  if (options.required) {
    throw new Error(`${key} is required`);
  }
  return undefined;
}

/**
 * Helper to get S3 config and validate filesystem context.
 */
function getFilesystemContext(dsConfig: DataServiceConfig): {
  error?: string;
  s3Config?: S3Config & { bucket: string };
  orgId?: string;
  projectId?: string;
} {
  if (!dsConfig.s3?.enabled || !dsConfig.s3?.bucket) {
    return { error: "Filesystem tools are not enabled. S3 configuration is required." };
  }

  if (!hasFilesystemContext()) {
    return { error: MISSING_PROJECT_ERROR };
  }

  const ctx = getEffectiveUserContext();
  if (!ctx.orgId || !ctx.projectId) {
    return { error: MISSING_PROJECT_ERROR };
  }

  return {
    s3Config: dsConfig.s3 as S3Config & { bucket: string },
    orgId: ctx.orgId,
    projectId: ctx.projectId,
  };
}

/**
 * fs_read - Read a file from the project's virtual disk.
 */
export function createFsReadTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_read",
    label: "Read File",
    description: `Read a file from the project's virtual disk (S3-backed, project-isolated).

Safe read-only operation — execute immediately without user confirmation.

- path: Relative path within the project (e.g., "documents/report.md")
- start_line: Optional start line (1-indexed)
- end_line: Optional end line (inclusive)

For large files, use start_line/end_line to read specific sections. Use fs_list first to explore the project structure.`,
    parameters: FsReadSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });
      const startLine = readNumberParam(params, "start_line", { required: false });
      const endLine = readNumberParam(params, "end_line", { required: false });

      try {
        const { content, metadata } = await s3ReadFile(
          fsCtx.s3Config!,
          fsCtx.orgId!,
          fsCtx.projectId!,
          path,
        );

        // Handle line range if specified
        let resultContent = content;
        let lineInfo: { total: number; start?: number; end?: number } | undefined;

        if (startLine !== undefined || endLine !== undefined) {
          const lines = content.split("\n");
          const start = Math.max(1, startLine ?? 1);
          const end = Math.min(lines.length, endLine ?? lines.length);

          resultContent = lines.slice(start - 1, end).join("\n");
          lineInfo = { total: lines.length, start, end };
        }

        return jsonResult({
          success: true,
          path,
          content: resultContent,
          size: metadata.size,
          lastModified: metadata.lastModified.toISOString(),
          ...(lineInfo && { lines: lineInfo }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_write - Create or overwrite a file in the project's virtual disk.
 */
export function createFsWriteTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_write",
    label: "Write File",
    description: `Create or overwrite a file in the project's virtual disk (S3-backed, project-isolated).

PUSH action — show a preview to the user and get confirmation before executing.

- path: Relative path within the project (e.g., "documents/report.md")
- content: The content to write to the file

Prefer fs_edit for small changes instead of rewriting entire files. All paths are relative to the project root; path traversal (..) is not allowed.`,
    parameters: FsWriteSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });
      const content = readStringParam(params, "content", { required: true });

      // Check file size limit
      const maxSize = dsConfig.s3?.maxFileSizeBytes ?? 10 * 1024 * 1024;
      if (content.length > maxSize) {
        return jsonResult({
          success: false,
          error: `File content exceeds maximum size of ${Math.round(maxSize / 1024 / 1024)}MB`,
          path,
        });
      }

      try {
        await s3WriteFile(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path, content);

        return jsonResult({
          success: true,
          path,
          message: `File written successfully`,
          size: content.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_edit - Edit specific content in a file (find and replace).
 */
export function createFsEditTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_edit",
    label: "Edit File",
    description: `Edit specific content in a file by finding and replacing text (S3-backed, project-isolated).

PUSH action — show a preview to the user and get confirmation before executing.

- path: Relative path to the file
- old_content: The exact text to find (must match exactly, including whitespace)
- new_content: The text to replace it with
- replace_all: Optional, if true replaces all occurrences (default: false)

IMPORTANT: Always use fs_read first to see the exact file content before editing.`,
    parameters: FsEditSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });
      const oldContent = readStringParam(params, "old_content", { required: true });
      const newContent = readStringParam(params, "new_content", { required: true });
      const replaceAll = readBooleanParam(params, "replace_all", { required: false }) ?? false;

      try {
        // Read the current file
        const { content } = await s3ReadFile(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path);

        // Check if old_content exists
        if (!content.includes(oldContent)) {
          return jsonResult({
            success: false,
            error: "The specified old_content was not found in the file",
            path,
            hint: "Use fs_read to see the exact file content. The old_content must match exactly.",
          });
        }

        // Perform replacement
        let newFileContent: string;
        let replacementCount: number;

        if (replaceAll) {
          const parts = content.split(oldContent);
          replacementCount = parts.length - 1;
          newFileContent = parts.join(newContent);
        } else {
          newFileContent = content.replace(oldContent, newContent);
          replacementCount = 1;
        }

        // Check file size limit
        const maxSize = dsConfig.s3?.maxFileSizeBytes ?? 10 * 1024 * 1024;
        if (newFileContent.length > maxSize) {
          return jsonResult({
            success: false,
            error: `Resulting file would exceed maximum size of ${Math.round(maxSize / 1024 / 1024)}MB`,
            path,
          });
        }

        // Write the updated content
        await s3WriteFile(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path, newFileContent);

        return jsonResult({
          success: true,
          path,
          message: `File edited successfully`,
          replacements: replacementCount,
          newSize: newFileContent.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_delete - Delete a file from the project's virtual disk.
 */
export function createFsDeleteTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_delete",
    label: "Delete File",
    description: `Delete a file from the project's virtual disk (S3-backed, project-isolated).

PUSH action — always confirm with the user before deleting. This cannot be undone.

- path: Relative path to the file to delete

Use fs_rmdir for directories.`,
    parameters: FsDeleteSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });

      try {
        // Check if file exists first
        const exists = await s3Exists(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path);
        if (!exists.exists) {
          return jsonResult({
            success: false,
            error: `File not found: ${path}`,
            path,
          });
        }

        if (exists.isDirectory) {
          return jsonResult({
            success: false,
            error: `Path is a directory, not a file. Use fs_rmdir to delete directories.`,
            path,
          });
        }

        await s3DeleteFile(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path);

        return jsonResult({
          success: true,
          path,
          message: `File deleted successfully`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_list - List files and directories in the project's virtual disk.
 */
export function createFsListTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_list",
    label: "List Directory",
    description: `List files and directories in the project's virtual disk (S3-backed, project-isolated).

Safe read-only operation — execute immediately without user confirmation.

- path: Optional relative path to list (default: project root)
- recursive: Optional, if true lists all files recursively (default: false)

Use this first to explore the project structure before reading or writing files.`,
    parameters: FsListSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: false });
      const recursive = readBooleanParam(params, "recursive", { required: false }) ?? false;

      try {
        const { files, directories } = await s3List(
          fsCtx.s3Config!,
          fsCtx.orgId!,
          fsCtx.projectId!,
          path,
          recursive,
        );

        return jsonResult({
          success: true,
          path: path || "/",
          recursive,
          directories,
          files: files.map((f) => ({
            path: f.path,
            size: f.size,
            lastModified: f.lastModified.toISOString(),
          })),
          summary: {
            totalDirectories: directories.length,
            totalFiles: files.length,
            totalSize: files.reduce((sum, f) => sum + f.size, 0),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path: path || "/" });
      }
    },
  };
}

/**
 * fs_mkdir - Create a directory in the project's virtual disk.
 */
export function createFsMkdirTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_mkdir",
    label: "Create Directory",
    description: `Create a directory in the project's virtual disk (S3-backed, project-isolated).

PUSH action — confirm with the user before creating.

- path: Relative path of the directory to create

Parent directories are created automatically if they don't exist.`,
    parameters: FsMkdirSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });

      try {
        await s3Mkdir(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path);

        return jsonResult({
          success: true,
          path,
          message: `Directory created successfully`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_rmdir - Delete a directory from the project's virtual disk.
 */
export function createFsRmdirTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_rmdir",
    label: "Delete Directory",
    description: `Delete a directory from the project's virtual disk (S3-backed, project-isolated).

PUSH action — always confirm with the user before deleting. This cannot be undone.

- path: Relative path of the directory to delete
- recursive: Optional, if true deletes directory and all contents (default: false)

With recursive=true, all files and subdirectories will be permanently deleted.`,
    parameters: FsRmdirSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });
      const recursive = readBooleanParam(params, "recursive", { required: false }) ?? false;

      try {
        const result = await s3Rmdir(
          fsCtx.s3Config!,
          fsCtx.orgId!,
          fsCtx.projectId!,
          path,
          recursive,
        );

        return jsonResult({
          success: true,
          path,
          message: `Directory deleted successfully`,
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_exists - Check if a file or directory exists in the project's virtual disk.
 */
export function createFsExistsTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_exists",
    label: "Check Exists",
    description: `Check if a file or directory exists in the project's virtual disk (S3-backed, project-isolated).

Safe read-only operation — execute immediately without user confirmation.

- path: Relative path to check

Returns whether the path exists and if it's a file or directory.`,
    parameters: FsExistsSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });

      try {
        const result = await s3Exists(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path);

        return jsonResult({
          success: true,
          path,
          exists: result.exists,
          type: result.exists ? (result.isDirectory ? "directory" : "file") : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * fs_stat - Get metadata for a file or directory in the project's virtual disk.
 */
export function createFsStatTool(dsConfig: DataServiceConfig) {
  return {
    name: "fs_stat",
    label: "Get File Info",
    description: `Get metadata for a file or directory in the project's virtual disk (S3-backed, project-isolated).

Safe read-only operation — execute immediately without user confirmation.

- path: Relative path to get metadata for

Returns file size, last modified date, and whether it's a file or directory.`,
    parameters: FsStatSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const fsCtx = getFilesystemContext(dsConfig);
      if (fsCtx.error) {
        return jsonResult({ success: false, error: fsCtx.error });
      }

      const params = args as Record<string, unknown>;
      const path = readStringParam(params, "path", { required: true });

      try {
        const metadata = await s3Stat(fsCtx.s3Config!, fsCtx.orgId!, fsCtx.projectId!, path);

        return jsonResult({
          success: true,
          path,
          type: metadata.isDirectory ? "directory" : "file",
          size: metadata.size,
          lastModified: metadata.lastModified.toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, error: message, path });
      }
    },
  };
}

/**
 * Create all filesystem tools.
 */
export function createFilesystemTools(dsConfig: DataServiceConfig) {
  if (!dsConfig.s3?.enabled) {
    return [];
  }

  return [
    createFsReadTool(dsConfig),
    createFsWriteTool(dsConfig),
    createFsEditTool(dsConfig),
    createFsDeleteTool(dsConfig),
    createFsListTool(dsConfig),
    createFsMkdirTool(dsConfig),
    createFsRmdirTool(dsConfig),
    createFsExistsTool(dsConfig),
    createFsStatTool(dsConfig),
  ];
}

/** Filesystem tool names */
export const FILESYSTEM_TOOL_NAMES = [
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_delete",
  "fs_list",
  "fs_mkdir",
  "fs_rmdir",
  "fs_exists",
  "fs_stat",
] as const;
