import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const timeoutMs = Number(process.env.OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS ?? 300_000);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  try {
    timeout = setNodeTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
}

function outputText(response: unknown): string {
  const output = (response as { output?: Array<{ type?: unknown; content?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((piece) => {
        if (!piece || typeof piece !== "object") {
          return [];
        }
        const record = piece as { text?: unknown };
        return typeof record.text === "string" ? [record.text] : [];
      });
    })
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (true) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) {
      return count;
    }
    count += 1;
    offset = next + needle.length;
  }
}

async function readSessionLogMentions(stateDir: string): Promise<Record<string, number>> {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const mentions = {
    apiCall: 0,
    apiFileList: 0,
    apiFileRead: 0,
    mcpNamespace: 0,
    mcpTool: 0,
    toolSearchPollution: 0,
  };
  const files = await fs.readdir(sessionsDir).catch(() => []);
  for (const file of files.filter((candidate) => candidate.endsWith(".jsonl"))) {
    const raw = await fs.readFile(path.join(sessionsDir, file), "utf8").catch(() => "");
    mentions.apiCall += countOccurrences(raw, "MCP.$api");
    mentions.apiFileList += countOccurrences(raw, "API.list");
    mentions.apiFileRead += countOccurrences(raw, "API.read");
    mentions.mcpNamespace += countOccurrences(raw, "MCP.fixture");
    mentions.mcpTool += countOccurrences(raw, "fixture__lookup_note");
    mentions.toolSearchPollution += countOccurrences(raw, 'tools.search("lookup note"');
  }
  return mentions;
}

async function main() {
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const model = process.env.OPENCLAW_MCP_CODE_MODE_MODEL?.trim() || "openclaw/main";
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");
  assert(stateDir, "missing OPENCLAW_STATE_DIR");

  const response = await fetchJson(`${gatewayUrl.replace(/\/$/, "")}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
      "x-openclaw-agent": "main",
      "x-openclaw-scopes": "operator.write",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "mcp code mode api file qa check:",
                "MCP and API are code-mode globals; they are defined only inside the exec tool, not in normal chat.",
                "Call exec with language javascript and this exact code:",
                'const files = await API.list("mcp");',
                'const root = await API.read("mcp/index.d.ts");',
                'const api = await API.read("mcp/fixture.d.ts");',
                'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
                'return { marker: "MCP_CODE_MODE_FILE_TOOL_RESULT", files: files.files.map((file) => file.path), rootHasFixture: root.content.includes("fixture"), headerHasLookup: api.content.includes("function lookupNote"), note: result.content?.[0]?.text };',
                "Do not use tools.search for MCP and do not call the inline MCP API helper.",
                "After exec finishes, send a normal assistant reply; do not stop after only the tool call.",
                "Reply with MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none only after the MCP call returns fixture-note-alpha.",
              ].join(" "),
            },
          ],
        },
      ],
      max_output_tokens: 1024,
      stream: false,
    }),
  });
  const finalText = outputText(response);
  const mentions = await readSessionLogMentions(stateDir);

  assert(
    finalText.includes("MCP_CODE_MODE_FILE_OK"),
    `agent did not complete MCP API file check: ${finalText}`,
  );
  assert(
    finalText.includes("fixture-note-alpha"),
    `agent did not return fixture note from MCP call: ${finalText}`,
  );
  assert(
    !/MCP\s+(?:was\s+)?not\s+defined|failed|error/i.test(finalText),
    `agent reported MCP failure instead of a successful call: ${finalText}`,
  );
  assert(mentions.apiFileRead > 0, "session log lacks API.read usage");
  assert(mentions.mcpNamespace > 0, "session log lacks MCP.fixture usage");
  assert(mentions.mcpTool > 0, "session log lacks fixture__lookup_note call");
  assert(mentions.apiCall === 0, "agent should not call MCP.$api when API files are available");
  assert(mentions.toolSearchPollution === 0, "agent should not use tools.search for MCP lookup");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        gatewayUrl,
        finalText,
        sessionLogMentions: mentions,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
