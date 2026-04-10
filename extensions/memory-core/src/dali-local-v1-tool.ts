import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  readNumberParam,
  readStringParam,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

const execFileAsync = promisify(execFile);

const DaliLocalV1RetrieveContextSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    corpusId: Type.Optional(Type.String({ minLength: 1 })),
    topic: Type.Optional(Type.String({ minLength: 1 })),
    documentLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    chunkLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    reflectionLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

type DaliLocalV1WorkspacePaths = {
  rootDir: string;
  scriptPath: string;
  dbPath: string;
};

type ExecFileAsyncResult = {
  stdout: string;
  stderr: string;
};

type DaliLocalV1ToolDeps = {
  execFile?: (
    file: string,
    args: readonly string[],
    options: { cwd: string; encoding: "utf8"; windowsHide: boolean },
  ) => Promise<ExecFileAsyncResult>;
};

type DaliLocalV1ContextBundle = {
  query?: unknown;
  documents?: unknown;
  reflections?: unknown;
  contextText?: unknown;
};

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function buildCandidateRoots(baseDir: string): string[] {
  const resolvedBase = path.resolve(baseDir);
  const candidates: string[] = [];
  if (path.basename(resolvedBase) === "dali-local-v1") {
    candidates.push(resolvedBase);
  }
  candidates.push(path.join(resolvedBase, "dali-local-v1"));
  return Array.from(new Set(candidates));
}

export function resolveDaliLocalV1WorkspacePaths(
  workspaceDir?: string,
): DaliLocalV1WorkspacePaths | null {
  const baseDir = workspaceDir ?? process.cwd();
  for (const candidateRoot of buildCandidateRoots(baseDir)) {
    const scriptPath = path.join(candidateRoot, "scripts", "dali_store.py");
    const dbPath = path.join(candidateRoot, "state", "dali.sqlite3");
    if (isFile(scriptPath) && isFile(dbPath)) {
      return {
        rootDir: candidateRoot,
        scriptPath,
        dbPath,
      };
    }
  }
  return null;
}

function buildRetrieveContextArgv(params: {
  paths: DaliLocalV1WorkspacePaths;
  query: string;
  corpusId?: string;
  topic?: string;
  documentLimit?: number;
  chunkLimit?: number;
  reflectionLimit?: number;
  maxChars?: number;
}): string[] {
  const argv = [
    params.paths.scriptPath,
    "--root",
    params.paths.rootDir,
    "retrieve-context",
    "--query",
    params.query,
  ];

  if (params.corpusId) {
    argv.push("--corpus-id", params.corpusId);
  }
  if (params.topic) {
    argv.push("--topic", params.topic);
  }
  if (typeof params.documentLimit === "number") {
    argv.push("--document-limit", String(params.documentLimit));
  }
  if (typeof params.chunkLimit === "number") {
    argv.push("--chunk-limit", String(params.chunkLimit));
  }
  if (typeof params.reflectionLimit === "number") {
    argv.push("--reflection-limit", String(params.reflectionLimit));
  }
  if (typeof params.maxChars === "number") {
    argv.push("--max-chars", String(params.maxChars));
  }

  return argv;
}

function normalizeContextBundle(
  raw: DaliLocalV1ContextBundle,
  query: string,
): {
  query: string;
  documents: unknown[];
  reflections: unknown[];
  contextText: string;
} {
  return {
    query: typeof raw.query === "string" ? raw.query : query,
    documents: Array.isArray(raw.documents) ? raw.documents : [],
    reflections: Array.isArray(raw.reflections) ? raw.reflections : [],
    contextText: typeof raw.contextText === "string" ? raw.contextText.trim() : "",
  };
}

function parseContextBundle(stdout: string, query: string) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("dali-local-v1 retrieve-context returned empty output");
  }
  const parsed = JSON.parse(trimmed) as DaliLocalV1ContextBundle;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dali-local-v1 retrieve-context returned a non-object JSON payload");
  }
  return normalizeContextBundle(parsed, query);
}

export function createDaliLocalV1RetrieveContextTool(params: {
  workspaceDir?: string;
  deps?: DaliLocalV1ToolDeps;
}): AnyAgentTool | null {
  const paths = resolveDaliLocalV1WorkspacePaths(params.workspaceDir);
  if (!paths) {
    return null;
  }

  const exec = params.deps?.execFile ?? execFileAsync;
  return {
    name: "dali_local_v1_retrieve_context",
    label: "Dali Local-v1 Retrieve Context",
    description:
      "Query the workspace's Dali/local-v1 SQLite substrate via the existing retrieve-context CLI path. This is Dali/local-v1-specific retrieval over imported document chunks plus local reflections, not generic memory.",
    parameters: DaliLocalV1RetrieveContextSchema,
    execute: async (_toolCallId, rawParams) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const corpusId = readStringParam(rawParams, "corpusId");
      const topic = readStringParam(rawParams, "topic");
      const documentLimit = readNumberParam(rawParams, "documentLimit");
      const chunkLimit = readNumberParam(rawParams, "chunkLimit");
      const reflectionLimit = readNumberParam(rawParams, "reflectionLimit");
      const maxChars = readNumberParam(rawParams, "maxChars");

      try {
        const { stdout } = await exec(
          "python3",
          buildRetrieveContextArgv({
            paths,
            query,
            corpusId,
            topic,
            documentLimit,
            chunkLimit,
            reflectionLimit,
            maxChars,
          }),
          {
            cwd: paths.rootDir,
            encoding: "utf8",
            windowsHide: true,
          },
        );
        const bundle = parseContextBundle(stdout, query);
        const details = {
          status: "ok" as const,
          rootDir: paths.rootDir,
          scriptPath: paths.scriptPath,
          dbPath: paths.dbPath,
          ...bundle,
        };
        const text = bundle.contextText
          ? `Dali local-v1 retrieval for "${bundle.query}"\n\n${bundle.contextText}`
          : `Dali local-v1 retrieval found no matching document or reflection context for "${bundle.query}".`;
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        const message = formatErrorMessage(error);
        return {
          content: [{ type: "text", text: `Dali local-v1 retrieval failed: ${message}` }],
          details: {
            status: "failed" as const,
            query,
            rootDir: paths.rootDir,
            scriptPath: paths.scriptPath,
            dbPath: paths.dbPath,
            error: message,
          },
        };
      }
    },
  };
}
