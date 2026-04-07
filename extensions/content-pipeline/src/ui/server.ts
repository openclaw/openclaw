/**
 * Web UI server for pipeline management dashboard.
 *
 * Serves the dashboard + provides REST API endpoints.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline, loadConfig, type Stage } from "../pipeline.js";
import { scrapeAll } from "../scraper/index.js";
import type { UploadResult } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(__dirname, "..", "..");
const OUTPUT_DIR = join(EXT_ROOT, "output");

// In-memory state
let currentRun: {
  id: string;
  type: string;
  status: "running" | "done" | "error";
  stages: Array<{ stage: string; status: string; message: string; time: string }>;
  error?: string;
  result?: Record<string, unknown>;
} | null = null;

const runHistory: NonNullable<typeof currentRun>[] = [];

// ── API Handlers ──

async function apiPreview(): Promise<unknown> {
  const config = loadConfig();
  const articles = await scrapeAll(config.sources);
  return { articles: articles.slice(0, 20) };
}

async function apiStartPipeline(type: string, topic?: string): Promise<unknown> {
  if (currentRun?.status === "running") {
    return { error: "A pipeline is already running" };
  }

  const id = `${type}-${new Date().toISOString().replace(/[T:]/g, "-").slice(0, 16)}`;
  currentRun = { id, type, status: "running", stages: [] };

  runPipeline({ pipelineType: type as "news" | "tutorial", topic, skipUpload: false }, (event) => {
    currentRun?.stages.push({
      stage: event.stage,
      status: event.status,
      message: event.message,
      time: new Date().toISOString(),
    });
  })
    .then((result) => {
      if (currentRun?.id === id) {
        currentRun.status = "done";
        currentRun.result = result as Record<string, unknown>;
        runHistory.unshift({ ...currentRun });
      }
    })
    .catch((err) => {
      if (currentRun?.id === id) {
        currentRun.status = "error";
        currentRun.error = (err as Error).message;
        runHistory.unshift({ ...currentRun });
      }
    });

  return { started: true, id };
}

function apiStatus(): unknown {
  return {
    current: currentRun,
    history: runHistory.slice(0, 10),
  };
}

function apiRuns(): unknown {
  try {
    if (!existsSync(OUTPUT_DIR)) return { runs: [] };

    const dirs = readdirSync(OUTPUT_DIR)
      .filter((d) => statSync(join(OUTPUT_DIR, d)).isDirectory())
      .sort()
      .reverse()
      .slice(0, 20);

    const runs = dirs.map((dir) => {
      const runDir = join(OUTPUT_DIR, dir);
      let uploads: UploadResult[] = [];
      let script = null;

      try {
        uploads = JSON.parse(readFileSync(join(runDir, "upload_results.json"), "utf-8"));
      } catch {}
      try {
        script = JSON.parse(readFileSync(join(runDir, "script.json"), "utf-8"));
      } catch {}

      const hasVideo = existsSync(join(runDir, "video_landscape.mp4"));
      const slidesDir = join(runDir, "slides");
      const slideCount = existsSync(slidesDir)
        ? readdirSync(slidesDir).filter((f) => f.endsWith(".png")).length
        : 0;

      return { id: dir, uploads, script, hasVideo, slideCount };
    });

    return { runs };
  } catch {
    return { runs: [] };
  }
}

function apiConfig(): unknown {
  return loadConfig();
}

// ── HTTP Server ──

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // API routes
  if (path.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");

    try {
      if (path === "/api/status" && req.method === "GET") {
        res.end(JSON.stringify(apiStatus()));
        return;
      }

      if (path === "/api/preview" && req.method === "POST") {
        const data = await apiPreview();
        res.end(JSON.stringify(data));
        return;
      }

      if (path === "/api/start" && req.method === "POST") {
        const body = await readBody(req);
        const { type, topic } = JSON.parse(body || "{}");
        const result = await apiStartPipeline(type ?? "news", topic);
        res.end(JSON.stringify(result));
        return;
      }

      if (path === "/api/runs" && req.method === "GET") {
        res.end(JSON.stringify(apiRuns()));
        return;
      }

      if (path === "/api/config" && req.method === "GET") {
        res.end(JSON.stringify(apiConfig()));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Serve dashboard HTML
  if (path === "/" || path === "/index.html") {
    const html = await readFile(join(__dirname, "dashboard.html"), "utf-8");
    res.setHeader("Content-Type", "text/html");
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

export function startDashboard(port = 3456) {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500);
      res.end(`Error: ${(err as Error).message}`);
    });
  });

  server.listen(port, () => {
    console.log(`\n🖥️  Dashboard running at http://localhost:${port}`);
    console.log("   Open in your browser to manage pipelines\n");
  });

  return server;
}
