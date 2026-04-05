import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { stateRouter } from "./routes/state.js";
import { commandRouter } from "./routes/command.js";
import { nlRouter } from "./routes/nl.js";
import { startPoller, addSSEClient, removeSSEClient, getCurrentState } from "./poller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load .env from project root (one level above dashboard/)
dotenvConfig({ path: join(__dirname, "../../.env") });

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// SSE endpoint
// ---------------------------------------------------------------------------
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const id = addSSEClient(res);

  // Send current state immediately if available
  const state = getCurrentState();
  if (state) {
    res.write(`event: init\ndata: ${JSON.stringify(state)}\n\n`);
  }

  // Keepalive ping every 25s
  const keepalive = setInterval(() => {
    try {
      res.write("event: ping\ndata: {}\n\n");
    } catch {
      clearInterval(keepalive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepalive);
    removeSSEClient(id);
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api", stateRouter);
app.use("/api", commandRouter);
app.use("/api", nlRouter);

// ---------------------------------------------------------------------------
// Static file serving (production build)
// ---------------------------------------------------------------------------
const distPath = join(__dirname, "../dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(join(distPath, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Control4 dashboard listening on http://0.0.0.0:${PORT}`);
  startPoller().catch((err) => {
    console.error("[server] poller startup failed:", err);
  });
});
