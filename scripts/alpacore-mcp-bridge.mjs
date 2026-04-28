#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ALPACORE_URL = normalizeBaseUrl(process.env.ALPACORE_URL ?? "http://127.0.0.1:5143");
const REQUEST_TIMEOUT_MS = normalizeTimeout(process.env.ALPACORE_TIMEOUT_MS, 240_000);

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizeTimeout(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function formatResult(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

async function fetchAlpaCore(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ALPACORE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `AlpaCore request failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText}` : ""}`,
      );
    }
    if (!bodyText) {
      return null;
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      return bodyText;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function toToolResult(action) {
  try {
    const value = await action();
    return {
      content: [
        {
          type: "text",
          text: formatResult(value),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: formatError(error),
        },
      ],
    };
  }
}

const server = new McpServer({
  name: "alpacore-local",
  version: "1.0.0",
});

server.registerTool(
  "arni_ask",
  {
    description: "Send a plain-text prompt to the live Arni endpoint.",
    inputSchema: {
      prompt: z.string().min(1).describe("The message to send to Arni."),
    },
  },
  ({ prompt }) =>
    toToolResult(async () => {
      const result = await fetchAlpaCore("/api/arni/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(prompt),
      });
      if (result && typeof result === "object" && "response" in result) {
        return result.response;
      }
      return result;
    }),
);

server.registerTool(
  "alpacore_health",
  {
    description: "Return the live AlpaCore health payload.",
  },
  () => toToolResult(() => fetchAlpaCore("/api/health")),
);

server.registerTool(
  "alpacore_ready",
  {
    description: "Return the live AlpaCore readiness payload.",
  },
  () => toToolResult(() => fetchAlpaCore("/api/ready")),
);

async function main() {
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    transport.onclose = undefined;
    server.close().then(resolveClosed, resolveClosed);
  };

  transport.onclose = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await closed;
  } finally {
    shutdown();
    await closed;
  }
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
});
