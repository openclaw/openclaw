import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

type EngineResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
};

function runEngine(args: string[]): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-m", "clawmodeler_engine", ...args], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      let json: unknown;
      try {
        const trimmed = stdout.trim();
        json = trimmed ? JSON.parse(trimmed) : undefined;
      } catch {
        json = undefined;
      }
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr, json });
    });
  });
}

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sendJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

const FILE_LIST_LIMIT = 500;

async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  type FileEntry = {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  };
  async function walk(current: string) {
    let entries: FileEntry[];
    try {
      entries = (await fs.readdir(current, { withFileTypes: true })) as FileEntry[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= FILE_LIST_LIMIT) {
        truncated = true;
        return;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return { files: files.toSorted(), truncated };
}

function clawModelerApiPlugin(): Plugin {
  return {
    name: "clawmodeler-api",
    configureServer(server) {
      server.middlewares.use("/api/clawmodeler", async (request, response) => {
        try {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          const route = url.pathname;

          if (request.method === "GET" && route === "/doctor") {
            const result = await runEngine(["doctor", "--json"]);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          if (request.method === "GET" && route === "/tools") {
            const result = await runEngine(["tools", "--json"]);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          if (request.method === "GET" && route === "/workspace") {
            const workspace = url.searchParams.get("workspace")?.trim();
            const runId = url.searchParams.get("runId")?.trim() || "demo";
            if (!workspace) {
              throw new Error("workspace is required");
            }
            const runRoot = path.join(workspace, "runs", runId);
            const { files, truncated } = await listFiles(runRoot);
            const payload = {
              workspace,
              runId,
              manifest: await readJsonIfExists(path.join(runRoot, "manifest.json")),
              qaReport: await readJsonIfExists(path.join(runRoot, "qa_report.json")),
              workflowReport: await readJsonIfExists(path.join(runRoot, "workflow_report.json")),
              reportMarkdown: await readTextIfExists(
                path.join(workspace, "reports", `${runId}_report.md`),
              ),
              files,
              filesTruncated: truncated,
            };
            sendJson(response, 200, { ok: true, json: payload });
            return;
          }

          if (request.method !== "POST") {
            sendJson(response, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const body = await readBody(request);
          if (route === "/init") {
            const result = await runEngine([
              "init",
              "--workspace",
              requiredString(body, "workspace"),
            ]);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          if (route === "/demo-full") {
            const result = await runEngine([
              "workflow",
              "demo-full",
              "--workspace",
              requiredString(body, "workspace"),
              "--run-id",
              requiredString(body, "runId"),
            ]);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          if (route === "/diagnose") {
            const args = ["workflow", "diagnose", "--workspace", requiredString(body, "workspace")];
            const runId = typeof body.runId === "string" ? body.runId.trim() : "";
            if (runId) {
              args.push("--run-id", runId);
            }
            const result = await runEngine(args);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          if (route === "/report-only") {
            const result = await runEngine([
              "workflow",
              "report-only",
              "--workspace",
              requiredString(body, "workspace"),
              "--run-id",
              requiredString(body, "runId"),
            ]);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          if (route === "/run") {
            const args = body.args;
            if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
              throw new Error("args must be a string array");
            }
            const result = await runEngine(args as string[]);
            sendJson(response, result.ok ? 200 : 500, result);
            return;
          }

          sendJson(response, 404, { ok: false, error: "not found" });
        } catch (error) {
          sendJson(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

export default defineConfig({
  root: here,
  build: {
    outDir: path.resolve(repoRoot, "dist/clawmodeler-desktop"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
  },
  plugins: [clawModelerApiPlugin()],
});
