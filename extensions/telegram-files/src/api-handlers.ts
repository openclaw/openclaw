import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { issueSessionToken, jsonResponse, readJsonBody, tokenTag } from "./auth.js";
import { exchangePairingCode } from "./pairing.js";
import {
  isAllowedRoot,
  isPathAllowed,
  safePath,
  sanitizeError,
  searchFiles,
} from "./path-utils.js";

const MAX_FILENAME_LENGTH = 255;

/** Handle POST /api/exchange — pair code → session token (no auth required). */
export async function handleExchange(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigin: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const pairCode = typeof body?.pairCode === "string" ? body.pairCode : "";
  const valid = exchangePairingCode(pairCode);

  if (!valid) {
    jsonResponse(res, 401, { error: "invalid or expired pairing code" }, corsOrigin);
    return;
  }

  const sessionToken = issueSessionToken();
  jsonResponse(res, 200, { token: sessionToken }, corsOrigin);
}

/** Handle GET /api/home — return the default start directory. */
export function handleHome(res: ServerResponse, allowedPaths: string[], corsOrigin: string): void {
  const home = allowedPaths.length > 0 ? path.resolve(allowedPaths[0]) : os.homedir();
  jsonResponse(res, 200, { path: home }, corsOrigin);
}

/** Handle GET /api/ls?path= — list directory contents. */
export async function handleLs(
  url: URL,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const dirPath = await safePath(url.searchParams.get("path") || "/");
  if (!dirPath || !(await isPathAllowed(dirPath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      jsonResponse(res, 400, { error: "not a directory" }, corsOrigin);
      return;
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        const fullPath = path.join(dirPath, e.name);
        let size = 0;
        let mtime = 0;
        try {
          const s = await fs.stat(fullPath);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {
          /* permission denied etc */
        }
        return {
          name: e.name,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
          size,
          mtime,
        };
      }),
    );

    // Sort: dirs first, then files, alphabetical
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    jsonResponse(res, 200, { path: dirPath, items }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to list: ${sanitizeError(err)}` }, corsOrigin);
  }
}

/** Handle GET /api/read?path= — read file content. */
export async function handleRead(
  url: URL,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const filePath = await safePath(url.searchParams.get("path") || "");
  if (!filePath || !(await isPathAllowed(filePath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      jsonResponse(res, 400, { error: "not a file" }, corsOrigin);
      return;
    }
    if (stat.size > 2 * 1024 * 1024) {
      jsonResponse(res, 400, { error: "file too large (max 2MB)" }, corsOrigin);
      return;
    }

    // Binary detection: check first 512 bytes for null bytes
    const fd = await fs.open(filePath, "r");
    let isBinary = false;
    try {
      const probe = Buffer.alloc(512);
      const { bytesRead } = await fd.read(probe, 0, 512, 0);
      isBinary = probe.subarray(0, bytesRead).includes(0);
    } finally {
      await fd.close();
    }
    if (isBinary) {
      jsonResponse(res, 400, { error: "binary file — cannot edit" }, corsOrigin);
      return;
    }

    const content = await fs.readFile(filePath, "utf-8");
    jsonResponse(res, 200, { path: filePath, content, size: stat.size }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to read: ${sanitizeError(err)}` }, corsOrigin);
  }
}

/** Handle POST /api/write — save file content. */
export async function handleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const filePath = await safePath(typeof body?.path === "string" ? body.path : "");
  const content = typeof body?.content === "string" ? body.content : null;

  if (!filePath || content === null) {
    jsonResponse(res, 400, { error: "path and content required" }, corsOrigin);
    return;
  }

  if (!(await isPathAllowed(filePath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    console.log(`[telegram-files] WRITE ${filePath} by token ${tokenTag(req)}`);
    jsonResponse(res, 200, { ok: true, path: filePath }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to write: ${sanitizeError(err)}` }, corsOrigin);
  }
}

/** Handle POST /api/upload — raw binary upload. */
export async function handleUpload(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const targetDir = await safePath(url.searchParams.get("dir") || "");
  const fileName = url.searchParams.get("name") || "";

  if (
    !targetDir ||
    !fileName ||
    fileName.length > MAX_FILENAME_LENGTH ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    fileName === ".." ||
    fileName === "."
  ) {
    jsonResponse(res, 400, { error: "dir and valid name required" }, corsOrigin);
    return;
  }

  const constructedPath = path.join(targetDir, fileName);
  const filePath = await safePath(constructedPath);
  if (!filePath || !(await isPathAllowed(filePath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  // Read raw body (max 50MB)
  const maxUpload = 50 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  let requestError = false;

  await new Promise<void>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxUpload) {
        overflow = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", () => {
      requestError = true;
      resolve();
    });
    req.on("close", () => resolve());
  });

  if (overflow) {
    jsonResponse(res, 413, { error: "file too large (max 50MB)" }, corsOrigin);
    return;
  }
  if (requestError) {
    jsonResponse(res, 500, { error: "upload stream error" }, corsOrigin);
    return;
  }

  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, Buffer.concat(chunks));
    console.log(`[telegram-files] UPLOAD ${filePath} (${size} bytes) by token ${tokenTag(req)}`);
    jsonResponse(res, 200, { ok: true, path: filePath, size }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to upload: ${sanitizeError(err)}` }, corsOrigin);
  }
}

/** Handle POST /api/mkdir — create directory. */
export async function handleMkdir(
  req: IncomingMessage,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const dirPath = await safePath(typeof body?.path === "string" ? body.path : "");

  if (!dirPath) {
    jsonResponse(res, 400, { error: "path required" }, corsOrigin);
    return;
  }

  if (!(await isPathAllowed(dirPath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  try {
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`[telegram-files] MKDIR ${dirPath} by token ${tokenTag(req)}`);
    jsonResponse(res, 200, { ok: true, path: dirPath }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to mkdir: ${sanitizeError(err)}` }, corsOrigin);
  }
}

/** Handle DELETE /api/delete?path= — remove file or directory. */
export async function handleDelete(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const targetPath = await safePath(url.searchParams.get("path") || "");
  if (!targetPath) {
    jsonResponse(res, 400, { error: "invalid path" }, corsOrigin);
    return;
  }

  if (!(await isPathAllowed(targetPath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  // Prevent deleting allowed root directories (e.g. home dir)
  if (await isAllowedRoot(targetPath, allowedPaths)) {
    jsonResponse(res, 403, { error: "cannot delete a root allowed path" }, corsOrigin);
    return;
  }

  try {
    await fs.rm(targetPath, { recursive: true });
    console.log(`[telegram-files] DELETE ${targetPath} by token ${tokenTag(req)}`);
    jsonResponse(res, 200, { ok: true }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to delete: ${sanitizeError(err)}` }, corsOrigin);
  }
}

/** Handle GET /api/search?path=&q= — recursive file search. */
export async function handleSearch(
  url: URL,
  res: ServerResponse,
  allowedPaths: string[],
  corsOrigin: string,
): Promise<void> {
  const basePath = await safePath(url.searchParams.get("path") || "/");
  const query = (url.searchParams.get("q") || "").trim();

  if (!basePath || !(await isPathAllowed(basePath, allowedPaths))) {
    jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
    return;
  }

  if (query.length < 1 || query.length > 256) {
    jsonResponse(res, 400, { error: "query parameter 'q' required (1-256 chars)" }, corsOrigin);
    return;
  }

  try {
    const results = await searchFiles(basePath, query);
    jsonResponse(res, 200, { path: basePath, query, results }, corsOrigin);
  } catch (err) {
    jsonResponse(res, 500, { error: `Failed to search: ${sanitizeError(err)}` }, corsOrigin);
  }
}
