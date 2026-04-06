import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type ResponsesInputItem = Record<string, unknown>;

type StreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        id: string;
        status: "completed";
        output: Array<Record<string, unknown>>;
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
    };

type MockOpenAiRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  toolOutput: string;
  model: string;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function writeSse(res: ServerResponse, events: StreamEvent[]) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function extractLastUserText(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = item.content
      .filter(
        (entry): entry is { type: "input_text"; text: string } =>
          !!entry &&
          typeof entry === "object" &&
          (entry as { type?: unknown }).type === "input_text" &&
          typeof (entry as { text?: unknown }).text === "string",
      )
      .map((entry) => entry.text)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function extractToolOutput(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.type === "function_call_output" && typeof item.output === "string" && item.output) {
      return item.output;
    }
  }
  return "";
}

function extractAllUserTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = item.content
      .filter(
        (entry): entry is { type: "input_text"; text: string } =>
          !!entry &&
          typeof entry === "object" &&
          (entry as { type?: unknown }).type === "input_text" &&
          typeof (entry as { text?: unknown }).text === "string",
      )
      .map((entry) => entry.text)
      .join("\n")
      .trim();
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

function normalizePromptPathCandidate(candidate: string) {
  const trimmed = candidate.trim().replace(/^`+|`+$/g, "");
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^\.\//, "");
  if (
    normalized.includes("/") ||
    /\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)$/i.test(normalized)
  ) {
    return normalized;
  }
  return null;
}

function readTargetFromPrompt(prompt: string) {
  const backtickedMatches = Array.from(prompt.matchAll(/`([^`]+)`/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => !!value);
  if (backtickedMatches.length > 0) {
    return backtickedMatches[0];
  }

  const quotedMatches = Array.from(prompt.matchAll(/"([^"]+)"/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => !!value);
  if (quotedMatches.length > 0) {
    return quotedMatches[0];
  }

  const repoScoped = /\b(?:repo\/[^\s`",)]+|QA_[A-Z_]+\.md)\b/.exec(prompt)?.[0]?.trim();
  if (repoScoped) {
    return repoScoped;
  }

  if (/\bdocs?\b/i.test(prompt)) {
    return "repo/docs/help/testing.md";
  }
  if (/\bscenario|kickoff|qa\b/i.test(prompt)) {
    return "QA_KICKOFF_TASK.md";
  }
  return "repo/package.json";
}

function buildToolCallEventsWithArgs(name: string, args: Record<string, unknown>): StreamEvent[] {
  const callId = `call_mock_${name}_1`;
  const serialized = JSON.stringify(args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: `fc_mock_${name}_1`,
        call_id: callId,
        name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: serialized },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: `fc_mock_${name}_1`,
        call_id: callId,
        name,
        arguments: serialized,
      },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_mock_${name}_1`,
        status: "completed",
        output: [
          {
            type: "function_call",
            id: `fc_mock_${name}_1`,
            call_id: callId,
            name,
            arguments: serialized,
          },
        ],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

function extractRememberedFact(userTexts: string[]) {
  for (const text of userTexts) {
    const qaCanaryMatch = /\bqa canary code is\s+([A-Za-z0-9-]+)/i.exec(text);
    if (qaCanaryMatch?.[1]) {
      return qaCanaryMatch[1];
    }
  }
  for (const text of userTexts) {
    const match = /remember(?: this fact for later)?:\s*([A-Za-z0-9-]+)/i.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function buildAssistantText(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  const userTexts = extractAllUserTexts(input);
  const rememberedFact = extractRememberedFact(userTexts);
  const model = typeof body.model === "string" ? body.model : "";

  if (/what was the qa canary code/i.test(prompt) && rememberedFact) {
    return `Protocol note: the QA canary code was ${rememberedFact}.`;
  }
  if (/remember this fact/i.test(prompt) && rememberedFact) {
    return `Protocol note: acknowledged. I will remember ${rememberedFact}.`;
  }
  if (/switch(?:ing)? models?/i.test(prompt)) {
    return `Protocol note: model switch acknowledged. Continuing on ${model || "the requested model"}.`;
  }
  if (toolOutput && /delegate|subagent/i.test(prompt)) {
    return `Protocol note: delegated result acknowledged. The bounded subagent task returned and is folded back into the main thread.`;
  }
  if (toolOutput && /worked, failed, blocked|worked\/failed\/blocked|follow-up/i.test(prompt)) {
    return `Worked:\n- Read seeded QA material.\n- Expanded the report structure.\nFailed:\n- None observed in mock mode.\nBlocked:\n- No live provider evidence in this lane.\nFollow-up:\n- Re-run with a real model for qualitative coverage.`;
  }
  if (toolOutput && /lobster invaders/i.test(prompt)) {
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return "";
    }
    return `Protocol note: Lobster Invaders built at lobster-invaders.html.`;
  }
  if (toolOutput) {
    const snippet = toolOutput.replace(/\s+/g, " ").trim().slice(0, 220);
    return `Protocol note: I reviewed the requested material. Evidence snippet: ${snippet || "no content"}`;
  }
  if (prompt) {
    return `Protocol note: acknowledged. Continue with the QA scenario plan and report worked, failed, and blocked items.`;
  }
  return "Protocol note: mock OpenAI server ready.";
}

function buildToolCallEvents(prompt: string): StreamEvent[] {
  const targetPath = readTargetFromPrompt(prompt);
  return buildToolCallEventsWithArgs("read", { path: targetPath });
}

function buildAssistantEvents(text: string): StreamEvent[] {
  const outputItem = {
    type: "message",
    id: "msg_mock_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  } as const;
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_mock_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: outputItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_mock_msg_1",
        status: "completed",
        output: [outputItem],
        usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
      },
    },
  ];
}

function buildResponsesPayload(body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  if (/lobster invaders/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return buildToolCallEventsWithArgs("write", {
        path: "lobster-invaders.html",
        content: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Lobster Invaders</title></head>
  <body><h1>Lobster Invaders</h1><p>Tiny playable stub.</p></body>
</html>`,
      });
    }
  }
  if (/delegate|subagent/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: "Inspect the QA workspace and return one concise protocol note.",
      label: "qa-sidecar",
      thread: false,
    });
  }
  if (
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(prompt) &&
    !toolOutput
  ) {
    return buildToolCallEventsWithArgs("read", { path: "QA_SCENARIO_PLAN.md" });
  }
  if (!toolOutput && /\b(read|inspect|repo|docs|scenario|kickoff)\b/i.test(prompt)) {
    return buildToolCallEvents(prompt);
  }
  return buildAssistantEvents(buildAssistantText(input, body));
}

export async function startQaMockOpenAiServer(params?: { host?: string; port?: number }) {
  const host = params?.host ?? "127.0.0.1";
  let lastRequest: MockOpenAiRequestSnapshot | null = null;
  const requests: MockOpenAiRequestSnapshot[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      writeJson(res, 200, { ok: true, status: "live" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      writeJson(res, 200, {
        data: [
          { id: "gpt-5.4", object: "model" },
          { id: "gpt-5.4-alt", object: "model" },
        ],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/debug/last-request") {
      writeJson(res, 200, lastRequest ?? { ok: false, error: "no request recorded" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/debug/requests") {
      writeJson(res, 200, requests);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
      lastRequest = {
        raw,
        body,
        prompt: extractLastUserText(input),
        toolOutput: extractToolOutput(input),
        model: typeof body.model === "string" ? body.model : "",
      };
      requests.push(lastRequest);
      if (requests.length > 50) {
        requests.splice(0, requests.length - 50);
      }
      const events = buildResponsesPayload(body);
      if (body.stream === false) {
        const completion = events.at(-1);
        if (!completion || completion.type !== "response.completed") {
          writeJson(res, 500, { error: "mock completion failed" });
          return;
        }
        writeJson(res, 200, completion.response);
        return;
      }
      writeSse(res, events);
      return;
    }
    writeJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params?.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa mock openai failed to bind");
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
