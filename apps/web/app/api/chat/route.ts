import { createUIMessageStream, type UIMessage } from "ai";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// Allow streaming responses up to 10 minutes
export const maxDuration = 600;

/** Resolve the repo root (two levels up from apps/web/) */
function repoRoot(): string {
  return resolve(process.cwd(), "..", "..");
}

type NdjsonEvent = {
  event: string;
  runId?: string;
  stream?: string;
  data?: Record<string, unknown>;
  seq?: number;
  ts?: number;
  sessionKey?: string;
  status?: string;
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string | null }>;
    meta?: Record<string, unknown>;
  };
};

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Extract the latest user message text
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  const userText =
    lastUserMessage?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n") ?? "";

  if (!userText.trim()) {
    return new Response("No message provided", { status: 400 });
  }

  const root = repoRoot();
  const scriptPath = resolve(root, "scripts", "run-node.mjs");

  const stream = createUIMessageStream({
    async execute({ writer }) {
      const textPartId = `text-${Date.now()}`;
      let started = false;

      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(
          "node",
          [scriptPath, "agent", "--agent", "main", "--message", userText, "--stream-json"],
          {
            cwd: root,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        const rl = createInterface({ input: child.stdout });

        rl.on("line", (line: string) => {
          if (!line.trim()) return;

          let event: NdjsonEvent;
          try {
            event = JSON.parse(line) as NdjsonEvent;
          } catch {
            return; // skip non-JSON lines (e.g. banner)
          }

          // Handle assistant text deltas
          if (event.event === "agent" && event.stream === "assistant") {
            const delta =
              typeof event.data?.delta === "string" ? event.data.delta : undefined;
            if (delta) {
              if (!started) {
                writer.write({ type: "text-start", id: textPartId });
                started = true;
              }
              writer.write({ type: "text-delta", id: textPartId, delta });
            }
          }

          // Handle lifecycle end
          if (
            event.event === "agent" &&
            event.stream === "lifecycle" &&
            event.data?.phase === "end"
          ) {
            if (started) {
              writer.write({ type: "text-end", id: textPartId });
            }
          }
        });

        child.on("close", (code) => {
          // If we never started text, emit an empty response
          if (!started) {
            writer.write({ type: "text-start", id: textPartId });
            writer.write({
              type: "text-delta",
              id: textPartId,
              delta: "(No response from agent)",
            });
            writer.write({ type: "text-end", id: textPartId });
          }
          if (code !== 0 && code !== null) {
            // Non-zero exit but we already streamed what we could
          }
          resolvePromise();
        });

        child.on("error", (err) => {
          if (!started) {
            writer.write({ type: "text-start", id: textPartId });
            writer.write({
              type: "text-delta",
              id: textPartId,
              delta: `Error starting agent: ${err.message}`,
            });
            writer.write({ type: "text-end", id: textPartId });
          }
          resolvePromise();
        });

        // Log stderr for debugging
        child.stderr?.on("data", (chunk: Buffer) => {
          console.error("[openclaw stderr]", chunk.toString());
        });
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return `Agent error: ${message}`;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
