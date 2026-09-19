import crypto from "node:crypto";
import path from "node:path";
import type { AgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  asOptionalRecord,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectStrictBase64 } from "./shared/base64.js";
import { throwFromNodePayload } from "./shared/errors.js";
import type { FileTransferNodeInvokeCommand } from "./shared/node-invoke-policy-commands.js";

const MAX_BYTES = 16 * 1024 * 1024;
const DIRECTORY_PAGE_SIZE = 4096;

function relativeWithin(root: string, target: string, paths = path): string {
  const relative = paths.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    throw new Error("Path is outside the configured node workspace");
  }
  return relative;
}

/** Translate workspace operations to existing policy-checked node commands. */
export function createNodeWorkspaceBridge(options: {
  nodeId: string;
  workspaceDir: string;
  remoteRoot: string;
  invoke: OpenClawPluginApi["runtime"]["nodes"]["invoke"];
  signal: AbortSignal;
}): AgentWorkspaceAccess["bridge"] {
  const workspaceDir = path.resolve(options.workspaceDir);
  const remoteRoot = path.posix.resolve(options.remoteRoot);
  const remotePath = (params: { filePath: string; cwd?: string }) => {
    const local = path.resolve(params.cwd ?? workspaceDir, params.filePath);
    return path.posix.join(
      remoteRoot,
      relativeWithin(workspaceDir, local).split(path.sep).join("/"),
    );
  };
  const invoke = async (
    command: FileTransferNodeInvokeCommand,
    params: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ) => {
    const signal = callerSignal ? AbortSignal.any([options.signal, callerSignal]) : options.signal;
    signal.throwIfAborted();
    const result = asOptionalRecord(
      await options.invoke({
        nodeId: options.nodeId,
        command,
        params: { followSymlinks: false, ...params },
        signal,
        timeoutMs: 60_000,
      }),
    );
    signal.throwIfAborted();
    const payload = asOptionalRecord(result?.payload);
    if (!payload) {
      throw new Error(`Invalid ${command} response`);
    }
    if (payload.ok !== true) {
      if (payload.code === "NOT_FOUND") {
        if (command === "file.stat") {
          return null;
        }
        throw Object.assign(new Error(`${command}: path not found`), { code: "ENOENT" });
      }
      throwFromNodePayload(command, payload);
    }
    if (typeof payload.path !== "string" || !path.posix.isAbsolute(payload.path)) {
      throw new Error(`Missing canonical path in ${command} response`);
    }
    relativeWithin(remoteRoot, payload.path, path.posix);
    return payload;
  };

  const readFileWithSource = async (
    params: Parameters<NonNullable<AgentWorkspaceAccess["bridge"]["readFileWithSource"]>>[0],
    followParentSymlinks = false,
  ) => {
    const maxBytes = Math.min(params.maxBytes ?? MAX_BYTES, MAX_BYTES);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error("maxBytes must be a non-negative safe integer");
    }
    const payload = await invoke(
      "file.fetch",
      {
        path: remotePath(params),
        maxBytes: Math.max(1, maxBytes),
        ...(followParentSymlinks ? { rootPath: remoteRoot, followSymlinks: true } : {}),
      },
      params.signal,
    );
    const base64 = typeof payload?.base64 === "string" ? payload.base64 : "";
    const size = inspectStrictBase64(base64);
    if (
      !payload ||
      typeof payload.base64 !== "string" ||
      size === undefined ||
      size > maxBytes ||
      payload.size !== size
    ) {
      throw new Error("Invalid or oversized file.fetch payload");
    }
    const data = Buffer.from(base64, "base64");
    if (crypto.createHash("sha256").update(data).digest("hex") !== payload.sha256) {
      throw new Error("file.fetch sha256 mismatch");
    }
    // SAFETY: invoke rejects payloads whose path is not an absolute string.
    const canonicalPath = payload.path as string;
    return {
      data,
      canonicalPath,
      workspaceRelativePath: relativeWithin(remoteRoot, canonicalPath, path.posix),
    };
  };

  return {
    // Bootstrap permits parent aliases inside the workspace; document RPCs
    // use readFile and keep their existing no-alias semantics.
    readFileWithSource: (params) => readFileWithSource(params, true),
    async readFile(params) {
      return (await readFileWithSource(params)).data;
    },
    async writeFile(params) {
      // file.write binds its own canonical target during authorization. It does
      // not accept a caller's earlier mutation pin or provide old-content CAS.
      if (params.pinnedPath !== undefined) {
        throw new Error("Node workspace writes do not support caller-supplied mutation pins");
      }
      const data = Buffer.isBuffer(params.data)
        ? params.data
        : Buffer.from(params.data, params.encoding ?? "utf8");
      if (data.byteLength > MAX_BYTES) {
        throw new Error("Node workspace write exceeds the file-transfer byte limit");
      }
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      const payload = await invoke(
        "file.write",
        {
          path: remotePath(params),
          contentBase64: data.toString("base64"),
          overwrite: true,
          rejectHardlinks: true,
          createParents: params.mkdir !== false,
          expectedSha256: sha256,
        },
        params.signal,
      );
      if (payload?.size !== data.byteLength || payload.sha256 !== sha256) {
        throw new Error("file.write receipt does not match the submitted bytes");
      }
    },
    async stat(params) {
      const payload = await invoke("file.stat", { path: remotePath(params) }, params.signal);
      if (!payload) {
        return null;
      }
      if (
        (payload.type !== "file" && payload.type !== "directory") ||
        typeof payload.size !== "number" ||
        !Number.isSafeInteger(payload.size) ||
        payload.size < 0 ||
        typeof payload.mtimeMs !== "number" ||
        !Number.isFinite(payload.mtimeMs)
      ) {
        throw new Error("Invalid file.stat metadata");
      }
      return { type: payload.type, size: payload.size, mtimeMs: payload.mtimeMs };
    },
    async readDirectory(params) {
      const entries: { name: string; isDirectory: boolean }[] = [];
      let offset = 0;
      while (true) {
        const payload = await invoke(
          "dir.list",
          {
            path: remotePath(params),
            maxEntries: DIRECTORY_PAGE_SIZE,
            ...(offset > 0 ? { pageToken: String(offset) } : {}),
          },
          params.signal,
        );
        if (
          !payload ||
          !Array.isArray(payload.entries) ||
          payload.entries.length > DIRECTORY_PAGE_SIZE
        ) {
          throw new Error("Invalid dir.list response");
        }
        for (const value of payload.entries) {
          const entry = asOptionalRecord(value);
          if (
            !entry ||
            typeof entry.name !== "string" ||
            !entry.name ||
            entry.name === "." ||
            entry.name === ".." ||
            entry.name.includes("/") ||
            entry.name.includes("\0") ||
            (path.sep === "\\" && entry.name.includes("\\")) ||
            typeof entry.isDir !== "boolean"
          ) {
            throw new Error("Invalid dir.list entry");
          }
          entries.push({ name: entry.name, isDirectory: entry.isDir });
        }
        if (payload.truncated === false) {
          return entries;
        }
        const nextOffset =
          typeof payload.nextPageToken === "string"
            ? parseStrictNonNegativeInteger(payload.nextPageToken)
            : undefined;
        if (payload.truncated !== true || nextOffset === undefined || nextOffset <= offset) {
          throw new Error("Invalid dir.list continuation");
        }
        offset = nextOffset;
      }
    },
  };
}
