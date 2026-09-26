import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
  readMemoryFile,
  type MemoryWorkspaceFiles,
  type MemoryWorkspaceWatchRequest,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type MemoryWorkspaceMaintenance = NonNullable<MemoryWorkspaceFiles["maintenance"]>;

type MaintenanceCommand = {
  [K in keyof MemoryWorkspaceMaintenance]: {
    operation: "maintenance";
    method: K;
    args: Parameters<MemoryWorkspaceMaintenance[K]>;
  };
}[keyof MemoryWorkspaceMaintenance];

type FileCommand =
  | MaintenanceCommand
  | {
      operation: "list";
      extraPaths?: Parameters<MemoryWorkspaceFiles["listFiles"]>[1];
      multimodal?: Parameters<MemoryWorkspaceFiles["listFiles"]>[2];
    }
  | {
      operation: "inspect";
      filePath: string;
      multimodal?: Parameters<MemoryWorkspaceFiles["inspectFile"]>[2];
    }
  | { operation: "read"; params: Omit<Parameters<typeof readMemoryFile>[0], "workspaceDir"> }
  | { operation: "readForIndexing"; filePath: string }
  | {
      operation: "multimodal";
      entry: Parameters<MemoryWorkspaceFiles["buildMultimodalChunk"]>[0];
    };

/** Same-version file IPC; the provisioned adapter owns admission and configured roots. */
export async function serveMemoryFiles(options: {
  workspace: string;
  input: Readable;
  output: Writable;
  watch?: boolean;
}): Promise<void> {
  if (options.watch) {
    const { MemoryFileWatcher } = await import("../memory/file-watcher.js");
    const lines = createInterface({ input: options.input, crlfDelay: Infinity });
    let watcher: InstanceType<typeof MemoryFileWatcher> | undefined;
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= watcher?.close();
      // The stream can close while start awaits a directory probe. Stop new
      // admission immediately; the finally block still joins and reports close.
      void closing?.catch(() => undefined);
    };
    options.input.on("end", close).on("close", close);
    try {
      for await (const line of lines) {
        if (watcher) {
          throw new Error("Unexpected message on the Memory watch subscription");
        }
        // SAFETY: The provisioned adapter sends this same-version file-watch contract on stdin.
        const request = JSON.parse(line) as MemoryWorkspaceWatchRequest;
        const notify = (event: "change" | "unavailable") => {
          options.output.write(`${JSON.stringify(event)}\n`);
        };
        watcher = new MemoryFileWatcher({
          workspaceDir: path.resolve(options.workspace),
          agentId: request.agentId,
          settings: request.settings,
          onChange: () => notify("change"),
          onUnavailable: () => notify("unavailable"),
        });
        if (options.input.readableEnded || options.input.destroyed) {
          close();
          break;
        }
        await watcher.start();
      }
    } finally {
      options.input.off("end", close).off("close", close);
      lines.close();
      await (closing ?? watcher?.close());
    }
    return;
  }
  const chunks: Buffer[] = [];
  const inputChunks: AsyncIterable<unknown> = options.input;
  for await (const chunk of inputChunks) {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      throw new Error("Memory file request must be bytes");
    }
    chunks.push(Buffer.from(chunk));
  }
  const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Memory file request must be an object");
  }
  // SAFETY: The provisioned adapter serializes FileCommand after admitting the operation and roots.
  const request = decoded as FileCommand;
  const workspace = path.resolve(options.workspace);
  let result: unknown;
  let failure:
    | { message: string; name?: string; code?: string; publication?: "uncertain" | "committed" }
    | undefined;
  try {
    switch (request.operation) {
      case "maintenance":
        result = await runMaintenance(request, workspace);
        break;
      case "list": {
        const skipped: string[] = [];
        const files = await listMemoryFiles(
          workspace,
          request.extraPaths,
          request.multimodal,
          (p) => skipped.push(p),
        );
        result = { files, skipped };
        break;
      }
      case "inspect":
        result = await buildFileEntry(request.filePath, workspace, request.multimodal);
        break;
      case "read":
        result = await readMemoryFile({ ...request.params, workspaceDir: workspace });
        break;
      case "readForIndexing": {
        // Keep source identity attached to the opened file, including parent aliases.
        const parent = await root(path.dirname(request.filePath), {
          hardlinks: "allow",
          symlinks: "reject",
          maxBytes: Number.MAX_SAFE_INTEGER,
        });
        const read = await parent.read(path.basename(request.filePath));
        result = {
          content: read.buffer.toString("utf8"),
          canonicalRelativePath: path
            .relative(await fs.realpath(workspace), read.realPath)
            .replaceAll(path.sep, "/"),
        };
        break;
      }
      case "multimodal":
        result = await buildMultimodalChunkForIndexing(request.entry);
        break;
      default:
        throw new Error("Unknown Memory file operation");
    }
  } catch (error) {
    failure = {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error ? { name: error.name } : {}),
      ...(error &&
      typeof error === "object" &&
      "publication" in error &&
      (error.publication === "uncertain" || error.publication === "committed")
        ? { publication: error.publication }
        : {}),
      ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? { code: error.code }
        : {}),
    };
  }
  await new Promise<void>((resolve, reject) => {
    options.output.write(JSON.stringify(failure ? { error: failure } : { result }), (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function runMaintenance(request: MaintenanceCommand, workspace: string): Promise<unknown> {
  switch (request.method) {
    case "readFile":
      return (await fs.readFile(...request.args)).toString("base64");
    case "stat": {
      const [filePath, followSymlinks] = request.args;
      const info = followSymlinks ? await fs.stat(filePath) : await fs.lstat(filePath);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
        size: info.size,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
      };
    }
    case "listDirectory":
      return (await fs.readdir(request.args[0], { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    case "mkdir":
      await fs.mkdir(request.args[0], { recursive: true });
      return null;
    case "rename":
      return await fs.rename(...request.args);
    case "resolveWritePath": {
      const { resolveMemoryWritePath } = await import("../short-term-promotion-memory-write.js");
      return await resolveMemoryWritePath(...request.args);
    }
    case "commitContent": {
      const { commitMemoryContent } = await import("../short-term-promotion-memory-write.js");
      return await commitMemoryContent(...request.args);
    }
    case "resolveDreamsPath": {
      const { resolveDreamsPath } = await import("../dreaming-dreams-file.js");
      return await resolveDreamsPath(workspace);
    }
    case "readDreams": {
      const { readDreamsFile } = await import("../dreaming-dreams-file.js");
      return await readDreamsFile(...request.args);
    }
    case "writeDreams": {
      const { writeDreamsFileAtomic } = await import("../dreaming-dreams-file.js");
      return await writeDreamsFileAtomic(...request.args);
    }
    case "replaceReport": {
      const { replaceDreamingMarkdownFile } = await import("../dreaming-markdown.js");
      return await replaceDreamingMarkdownFile(...request.args);
    }
    case "appendCorpus": {
      const { appendSessionCorpusText } = await import("../session-ingestion.js");
      return await appendSessionCorpusText(...request.args);
    }
    default:
      throw new Error("Unknown Memory maintenance operation");
  }
}
