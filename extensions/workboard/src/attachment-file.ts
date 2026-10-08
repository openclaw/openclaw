import path from "node:path";
import { readRegularFile, root } from "openclaw/plugin-sdk/file-access-runtime";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { MAX_ATTACHMENT_BYTES } from "./store-constants.js";

export type WorkboardAttachmentFileInput = {
  fileName: string;
  contentBase64: string;
  mimeType?: string;
};

function isTooLarge(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "too-large";
}

async function toAttachmentInput(
  filePath: string,
  buffer: Buffer,
  fileName: string | undefined,
  mimeType: string | undefined,
): Promise<WorkboardAttachmentFileInput> {
  const detected = mimeType?.trim() || (await detectMime({ buffer, filePath }));
  return {
    fileName: fileName?.trim() || path.basename(filePath),
    contentBase64: buffer.toString("base64"),
    ...(detected ? { mimeType: detected } : {}),
  };
}

/**
 * Reads an agent-supplied attachment path inside the agent workspace. Relative
 * paths resolve against the workspace; symlinks may not leave it.
 */
export async function readWorkspaceAttachmentFile(params: {
  workspaceDir: string | undefined;
  filePath: string;
  fileName?: string;
  mimeType?: string;
}): Promise<WorkboardAttachmentFileInput> {
  if (!params.workspaceDir) {
    throw new Error("attachment path needs an agent workspace; send contentBase64 instead.");
  }
  const requested = path.resolve(params.workspaceDir, params.filePath);
  let result;
  try {
    const workspace = await root(params.workspaceDir);
    result = await workspace.readAbsolute(requested, {
      maxBytes: MAX_ATTACHMENT_BYTES,
      symlinks: "follow-within-root",
    });
  } catch (error) {
    if (isTooLarge(error)) {
      throw new Error(`attachment must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`, {
        cause: error,
      });
    }
    throw new Error(
      `attachment path must be a regular file inside the agent workspace: ${params.filePath}`,
      { cause: error },
    );
  }
  return await toAttachmentInput(requested, result.buffer, params.fileName, params.mimeType);
}

/** Reads an operator-supplied attachment path for the local CLI. */
export async function readLocalAttachmentFile(params: {
  filePath: string;
  fileName?: string;
  mimeType?: string;
}): Promise<WorkboardAttachmentFileInput> {
  const filePath = path.resolve(params.filePath);
  let buffer: Buffer;
  try {
    ({ buffer } = await readRegularFile({ filePath, maxBytes: MAX_ATTACHMENT_BYTES }));
  } catch (error) {
    if (isTooLarge(error)) {
      throw new Error(`attachment must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`, {
        cause: error,
      });
    }
    throw error;
  }
  return await toAttachmentInput(filePath, buffer, params.fileName, params.mimeType);
}
