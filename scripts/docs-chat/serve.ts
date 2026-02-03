#!/usr/bin/env bun
/**
 * Docs-chat API with RAG (vector search).
 * Env: OPENAI_API_KEY, DOCS_CHAT_DB, PORT
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { Embeddings } from "./rag/embeddings.js";
import { DocsStore } from "./rag/store.js";
import { Retriever } from "./rag/retriever.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.join(__dirname, ".lance-db");
const dbPath = process.env.DOCS_CHAT_DB || defaultDbPath;
const port = Number(process.env.PORT || 3001);

// Validate API key
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

// Initialize RAG components
const embeddings = new Embeddings(apiKey);
const store = new DocsStore(dbPath, embeddings.dimensions);
const retriever = new Retriever(store, embeddings);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function streamOpenAI(
  systemPrompt: string,
  userMessage: string,
  onToken: (token: string) => void,
) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    const errorText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errorText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onToken(delta);
      } catch {
        // Ignore malformed SSE lines
      }
    }
  }
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = "";
  for await (const chunk of req) body += chunk;

  let message = "";
  try {
    message = JSON.parse(body || "{}").message;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (!message || typeof message !== "string") {
    sendJson(res, 400, { error: "message required" });
    return;
  }

  // Use RAG retriever instead of keyword matching
  const results = await retriever.retrieve(message, 8);

  if (results.length === 0) {
    res.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(
      "I couldn't find relevant documentation excerpts for that question. Try rephrasing or search the docs.",
    );
    return;
  }

  // Build context from retrieved chunks
  const context = results
    .map(
      (result) =>
        `[${result.chunk.title}](${result.chunk.url})\n${result.chunk.content.slice(0, 1200)}`,
    )
    .join("\n\n---\n\n");

  const systemPrompt =
    "You are a helpful assistant for OpenClaw documentation. " +
    "Answer only from the provided documentation excerpts. " +
    "If the answer is not in the excerpts, say so and suggest checking the docs. " +
    "Cite sources by name or URL when relevant.\n\nDocumentation excerpts:\n" +
    context;

  res.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Transfer-Encoding": "chunked",
  });

  try {
    await streamOpenAI(systemPrompt, message, (token) => {
      res.write(token);
    });
    res.end();
  } catch (err) {
    console.error(err);
    res.end("\n\n[Error contacting OpenAI]");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    const count = await store.count();
    sendJson(res, 200, { ok: true, chunks: count, mode: "vector" });
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    await handleChat(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, async () => {
  const count = await store.count();
  console.error(
    `docs-chat API (RAG) running at http://localhost:${port} (chunks: ${count})`,
  );
});
