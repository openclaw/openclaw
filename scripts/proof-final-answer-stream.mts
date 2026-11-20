import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../src/agents/embedded-agent-utils.ts";

const longReferenceDefinitionPrefix = "![example `x\n[tool:read] {}\nx`][long]\n\n[long]: <";
const longReferenceDestination = "x".repeat(2_100);
const multilineLabelReferencePrefix = "![example `x\n[tool:read] {}\nx`][a b c]\n\n[a\nb\nc]: <";
const multilineLabelReferenceDestination = `./${"x".repeat(2_100)}`;
const listContinuationReferencePrefix =
  "![example `x\n[tool:read] {}\nx`][id]\n\n- item\n\n    [id]: <./url";
const tableHeaderPrefix = "Intro `x\n[tool:read] {}\nx` | y\n";
const tableAlignmentPrefix = "Intro `x\n[tool:read] {}\nx` |\n---";
const twoDashTableAlignmentPrefix = "Intro `x\n[tool:read] {}\nx` |\n --";
const oneDashTableAlignmentPrefix = "Intro `x\n[tool:read] {}\nx` |\n -";
const shortTableAlignmentAfterColonPrefix = "Intro `x\n[tool:read] {}\nx` |\n:";
const shortTableAlignmentAfterLineEndingPrefix = "Intro `x\n[tool:read] {}\nx` |   \n:";
const nestedListContinuationReferencePrefix = [
  "![example `x\n[tool:read] {}\nx`][id]",
  "",
  "- level 1",
  "  - level 2",
  "    - level 3",
  "      - level 4",
  "        - level 5",
  "          - level 6",
  "            - level 7",
  "              - level 8",
  "",
  "                [id]: <./url",
].join("\n");
const ownershipCases = [
  {
    name: "inline image destination close",
    prefix: "![example `x\n[tool:read] {}\nx` label",
    suffix: "](/url)\n",
  },
  {
    name: "GFM table delimiter changes paragraph ownership",
    prefix: tableHeaderPrefix,
    suffix: ["--- ", "| ", "---", "\n"],
    allowVisibleClose: true,
  },
  {
    name: "GFM table alignment colon changes paragraph ownership",
    prefix: tableAlignmentPrefix,
    suffix: ":\n",
    allowVisibleClose: true,
  },
  {
    name: "GFM table alignment colon after two dashes",
    prefix: twoDashTableAlignmentPrefix,
    suffix: ":\n",
    allowVisibleClose: true,
  },
  {
    name: "GFM table alignment colon after one dash",
    prefix: oneDashTableAlignmentPrefix,
    suffix: ":\n",
    allowVisibleClose: true,
  },
  {
    name: "GFM one-dash table alignment after colon",
    prefix: shortTableAlignmentAfterColonPrefix,
    suffix: "-\n",
    allowVisibleClose: true,
  },
  {
    name: "GFM two-dash table alignment after colon",
    prefix: shortTableAlignmentAfterColonPrefix,
    suffix: "--\n",
    allowVisibleClose: true,
  },
  {
    name: "GFM short table alignment after line ending",
    prefix: shortTableAlignmentAfterLineEndingPrefix,
    suffix: "-\n",
    allowVisibleClose: true,
  },
  {
    name: "multiline reference title close",
    prefix: '[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '"',
  },
  {
    name: "multiline reference title after trailing escape",
    prefix: '[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\\',
    suffix: 'a"',
  },
  {
    name: "reference title with four-space indentation",
    prefix: '[indented-title]: /url\n    "title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '"',
  },
  {
    name: "multiline inline link title close",
    prefix: '[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '")\n',
  },
  {
    name: "quoted title after balanced destination",
    prefix: '[label](/u(x) "title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '")\n',
  },
  {
    name: "quoted title after multiline destination",
    prefix: '[label](/u(x)\n"title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '")\n',
  },
  {
    name: "link title across blockquote prefixes",
    prefix: '> [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: ['> "\n> ', ")\n"],
    allowVisibleClose: true,
  },
  {
    name: "link title across nested blockquote prefixes",
    prefix: '>    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: ['>    > "\n>    > ', ")\n"],
    allowVisibleClose: true,
  },
  {
    name: "link title across list-owned blockquote prefixes",
    prefix: '- item\n\n    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: ['    > "\n    > ', ")\n"],
    allowVisibleClose: true,
  },
  {
    name: "multiline parenthesized inline link title close",
    prefix: "[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n",
    suffix: "))\n",
  },
  {
    name: "next-line reference destination",
    prefix: "![example `x\n[tool:read] {}\nx`][next]\n\n[next]:\n",
    suffix: "/url\n",
  },
  {
    name: "list-owned next-line reference destination",
    prefix: "![example `x\n[tool:read] {}\nx`][list]\n\n- [list]:\n",
    suffix: "  /url\n",
  },
  {
    name: "multiline reference label and long destination",
    prefix: multilineLabelReferencePrefix,
    suffix: [multilineLabelReferenceDestination, ">\n"],
  },
  {
    name: "list continuation reference destination",
    prefix: listContinuationReferencePrefix,
    suffix: ">\n",
  },
  {
    name: "nested list continuation reference destination",
    prefix: nestedListContinuationReferencePrefix,
    suffix: ">\n",
  },
];
const expectInlineLinkTitleLeak = process.env.PROOF_EXPECT_INLINE_LINK_TITLE_LEAK === "1";
const expectParenthesizedLinkTitleLeak = process.env.PROOF_EXPECT_PAREN_LINK_TITLE_LEAK === "1";

for (const example of ownershipCases) {
  const stream = createAssistantVisibleStreamText("final_answer");
  const pending = stream.append(example.prefix);
  const suffixChunks = Array.isArray(example.suffix) ? example.suffix : [example.suffix];
  let corrected = pending;
  for (const suffix of suffixChunks) {
    corrected = stream.append(suffix);
  }
  const expected = sanitizeAssistantVisibleStreamText(
    example.prefix + suffixChunks.join(""),
    "final_answer",
  );
  if (!pending.text.includes("[tool:read] {}")) {
    throw new Error(`${example.name}: pending call did not reach final-answer projection`);
  }
  const expectsLeak =
    (example.name === "multiline inline link title close" && expectInlineLinkTitleLeak) ||
    (example.name === "multiline parenthesized inline link title close" &&
      expectParenthesizedLinkTitleLeak);
  if (expectsLeak) {
    if (!corrected.text.includes("[tool:read] {}") || expected.includes("[tool:read] {}")) {
      throw new Error(
        `${example.name}: expected the old cache behavior to leak the tool-call line`,
      );
    }
    console.log(
      JSON.stringify({
        case: example.name,
        phase: "final_answer",
        baselineLeakReproduced: true,
        canonicalHidesCall: true,
      }),
    );
    continue;
  }
  if (
    (!example.allowVisibleClose && corrected.delta !== null) ||
    corrected.text.includes("[tool:read] {}")
  ) {
    throw new Error(`${example.name}: ownership correction did not replace pending output`);
  }
  if (corrected.text !== expected) {
    throw new Error(`${example.name}: final text differs from canonical sanitization`);
  }
  console.log(
    JSON.stringify({
      case: example.name,
      phase: "final_answer",
      pendingCallObserved: true,
      correction: "replacement",
      finalText: corrected.text,
    }),
  );
}

const longReferenceChunks = [longReferenceDefinitionPrefix, longReferenceDestination, ">\n"];
const longReferenceStream = createAssistantVisibleStreamText("final_answer");
for (const chunk of longReferenceChunks) {
  longReferenceStream.append(chunk);
}
const longReferenceText = longReferenceChunks.join("");
if (
  longReferenceStream.text !==
    sanitizeAssistantVisibleStreamText(longReferenceText, "final_answer") ||
  longReferenceStream.text.includes("[tool:read] {}")
) {
  throw new Error("closing a long reference destination did not refresh image-alt ownership");
}
console.log(
  JSON.stringify({
    case: "long reference destination close",
    phase: "final_answer",
    destinationChars: longReferenceDestination.length,
    canonicalMatch: true,
    imageAltCallHidden: true,
  }),
);

const indentationChunks = ["    [tool:read] {}\n", "    ", "[tool:write] {}\n"];
const indentationStream = createAssistantVisibleStreamText("final_answer");
for (const chunk of indentationChunks) {
  indentationStream.append(chunk);
}
const indentationText = indentationChunks.join("");
const indentationExpected = sanitizeAssistantVisibleStreamText(indentationText, "final_answer");
if (
  indentationStream.text !== indentationExpected ||
  !indentationStream.text.includes("[tool:write] {}")
) {
  throw new Error("indented code continuation did not preserve its literal tool calls");
}
console.log(
  JSON.stringify({
    case: "indented code continuation",
    phase: "final_answer",
    literalCallsPreserved: true,
    finalText: indentationStream.text,
  }),
);

const lateIndentationChunks = [
  "[tool:read] {}\n\n    ",
  '[tool:write] {"path":"late-indent.txt"}\n',
];
const lateIndentationStream = createAssistantVisibleStreamText("final_answer");
for (const chunk of lateIndentationChunks) {
  lateIndentationStream.append(chunk);
}
const lateIndentationText = lateIndentationChunks.join("");
const lateIndentationExpected = sanitizeAssistantVisibleStreamText(
  lateIndentationText,
  "final_answer",
);
if (
  lateIndentationStream.text !== lateIndentationExpected ||
  lateIndentationStream.text !== '    [tool:write] {"path":"late-indent.txt"}'
) {
  throw new Error("content after an indentation-only line did not establish literal code");
}
console.log(
  JSON.stringify({
    case: "late indented code block",
    phase: "final_answer",
    literalCallPreserved: true,
    canonicalMatch: true,
  }),
);

const listFenceChunks = ["- ```text\n  [tool:read] {}", "\n  [tool:write] {}\n"];
const listFenceStream = createAssistantVisibleStreamText("final_answer");
for (const chunk of listFenceChunks) {
  listFenceStream.append(chunk);
}
const listFenceText = listFenceChunks.join("");
const listFenceExpected = sanitizeAssistantVisibleStreamText(listFenceText, "final_answer");
console.log(
  JSON.stringify({
    case: "list-owned fence continuation",
    phase: "final_answer",
    matchesCanonical: listFenceStream.text === listFenceExpected,
    literalCallsPreserved: listFenceStream.text.includes("[tool:write] {}"),
    finalText: listFenceStream.text,
  }),
);

const pendingCall = `[tool:write]\n{"path":"notes.txt","content":"${"x".repeat(4_096)}`;
const pendingStream = createAssistantVisibleStreamText("final_answer");
const pendingStartedAt = performance.now();
for (let offset = 0; offset < pendingCall.length; offset += 4) {
  pendingStream.append(pendingCall.slice(offset, offset + 4));
}
const pendingElapsedMs = Math.round(performance.now() - pendingStartedAt);
if (pendingStream.text !== pendingCall) {
  throw new Error("incomplete tool-call candidate did not remain provisional while streaming");
}
console.log(
  JSON.stringify({
    case: "pending-call projection work",
    phase: "final_answer",
    payloadChars: 4_096,
    deltaChars: 4,
    deltaCount: Math.ceil(pendingCall.length / 4),
    elapsedMs: pendingElapsedMs,
    pendingCandidateVisible: true,
    status: "ok",
  }),
);
const cliText = [
  pendingCall,
  '"}\n\n',
  "![example `x\n[tool:read] {}\nx` label](/url)\n\n",
  `${tableHeaderPrefix}--- | ---\n\n`,
  `${tableAlignmentPrefix}:\n\n`,
  `${twoDashTableAlignmentPrefix}:\n\n`,
  `${oneDashTableAlignmentPrefix}:\n\n`,
  `${shortTableAlignmentAfterColonPrefix}-\n\n`,
  `${shortTableAlignmentAfterColonPrefix}--\n\n`,
  `${shortTableAlignmentAfterLineEndingPrefix}-\n\n`,
  '[title]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n"\n\n',
  '[indented-title]: /url\n    "title\n`x\n[tool:read] {}\nx` trailing\n"\n\n',
  '[escaped-title]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\\a"\n\n',
  '[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n")\n\n',
  '[label](/u(x) "title\n`x\n[tool:read] {}\nx` trailing\n")\n\n',
  '[label](/u(x)\n"title\n`x\n[tool:read] {}\nx` trailing\n")\n\n',
  '> [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n> "\n> )\n\n',
  '>    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n>    > "\n>    > )\n\n',
  '- item\n\n    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n    > "\n    > )\n\n',
  "[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n))\n\n",
  '[tool:read] {}\n\n    [tool:write] {"path":"late-indent.txt"}\n\n',
  "![example `x\n[tool:read] {}\nx`][next]\n\n[next]:\n/url\n\n",
  `${longReferenceDefinitionPrefix}${longReferenceDestination}>\n\n`,
  `${multilineLabelReferencePrefix}${multilineLabelReferenceDestination}>\n\n`,
  `${listContinuationReferencePrefix}>\n\n`,
  "End of list.\n\n",
  `${nestedListContinuationReferencePrefix}>\n\n`,
  "End of nested list.\n\n",
  "    [tool:read] {}\n    [tool:write] {}\n\n",
  "- ```text\n  [tool:read] {}\n  [tool:write] {}\n\n",
  '```text\n[tool:read] {"path":"example.txt"}\n```\n',
  "![example `x\n[tool:read] {}\nx`][list]\n\n- [list]:\n  /url\n\n",
].join("");
const cliChunkSize = 256;
const inlineLinkTitlePrefix = '[label](/url "title\n`x\n[tool:read] {}\nx` trailing\n';
const escapedReferenceTitlePrefix =
  '[escaped-title]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\\';
const indentedReferenceTitlePrefix =
  '[indented-title]: /url\n    "title\n`x\n[tool:read] {}\nx` trailing\n';
const balancedDestinationTitlePrefix = '[label](/u(x) "title\n`x\n[tool:read] {}\nx` trailing\n';
const multilineDestinationTitlePrefix = '[label](/u(x)\n"title\n`x\n[tool:read] {}\nx` trailing\n';
const blockquoteTitlePrefix = '> [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n';
const nestedBlockquoteTitlePrefix = '>    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n';
const listBlockquoteTitlePrefix =
  '- item\n\n    > [label](/url "title\n`x\n[tool:read] {}\nx` trailing\n';
const parenthesizedLinkTitlePrefix = "[label](/url (title\n`x\n[tool:read] {}\nx` trailing\n";
const lateIndentationPrefix = "[tool:read] {}\n\n    ";
const longReferenceDestinationPrefix = `${longReferenceDefinitionPrefix}${longReferenceDestination}`;
const multilineLabelReferenceDestinationPrefix = `${multilineLabelReferencePrefix}${multilineLabelReferenceDestination}`;
const ownershipChunkBoundaries = [
  {
    prefix: tableHeaderPrefix,
    suffix: ["--- ", "| ", "---", "\n"],
    name: "GFM table delimiter",
  },
  {
    prefix: tableAlignmentPrefix,
    suffix: ":\n",
    name: "GFM table alignment colon",
  },
  {
    prefix: twoDashTableAlignmentPrefix,
    suffix: ":\n",
    name: "GFM table alignment colon after two dashes",
  },
  {
    prefix: oneDashTableAlignmentPrefix,
    suffix: ":\n",
    name: "GFM table alignment colon after one dash",
  },
  {
    prefix: shortTableAlignmentAfterColonPrefix,
    suffix: "-\n",
    name: "GFM one-dash table alignment after colon",
  },
  {
    prefix: shortTableAlignmentAfterColonPrefix,
    suffix: "--\n",
    name: "GFM two-dash table alignment after colon",
  },
  {
    prefix: shortTableAlignmentAfterLineEndingPrefix,
    suffix: "-\n",
    name: "GFM short table alignment after line ending",
  },
  {
    prefix: indentedReferenceTitlePrefix,
    suffix: '"',
    name: "reference title with four-space indentation",
  },
  {
    prefix: escapedReferenceTitlePrefix,
    suffix: 'a"',
    name: "reference title after trailing escape",
  },
  { prefix: inlineLinkTitlePrefix, suffix: '")\n', name: "inline-link title" },
  {
    prefix: balancedDestinationTitlePrefix,
    suffix: '")\n',
    name: "quoted title after balanced destination",
  },
  {
    prefix: multilineDestinationTitlePrefix,
    suffix: '")\n',
    name: "quoted title after multiline destination",
  },
  {
    prefix: blockquoteTitlePrefix,
    suffix: '> "\n> )\n',
    name: "link title across blockquote prefixes",
  },
  {
    prefix: nestedBlockquoteTitlePrefix,
    suffix: ['>    > "\n>    > ', ")\n"],
    name: "link title across nested blockquote prefixes",
  },
  {
    prefix: listBlockquoteTitlePrefix,
    suffix: ['    > "\n    > ', ")\n"],
    name: "link title across list-owned blockquote prefixes",
  },
  { prefix: parenthesizedLinkTitlePrefix, suffix: "))\n", name: "parenthesized inline-link title" },
  {
    prefix: lateIndentationPrefix,
    suffix: '[tool:write] {"path":"late-indent.txt"}\n',
    name: "late indented code block",
  },
  {
    prefix: longReferenceDestinationPrefix,
    suffix: ">\n",
    name: "long reference destination",
  },
  {
    prefix: multilineLabelReferenceDestinationPrefix,
    suffix: ">\n",
    name: "multiline reference label and long destination",
  },
  {
    prefix: listContinuationReferencePrefix,
    suffix: ">\n",
    name: "list continuation reference destination",
  },
  {
    prefix: nestedListContinuationReferencePrefix,
    suffix: ">\n",
    name: "nested list continuation reference destination",
  },
];
const cliDeltas: string[] = [];
let chunkCursor = 0;
for (const boundary of ownershipChunkBoundaries) {
  const start = cliText.indexOf(boundary.prefix, chunkCursor);
  if (start === -1) {
    throw new Error(`CLI proof text is missing the ${boundary.name} scenario`);
  }
  const cut = start + boundary.prefix.length;
  const suffixChunks = Array.isArray(boundary.suffix) ? boundary.suffix : [boundary.suffix];
  let end = cut;
  for (const suffix of suffixChunks) {
    if (!cliText.startsWith(suffix, end)) {
      throw new Error(
        `CLI proof text does not split the ${boundary.name} close at its expected boundary`,
      );
    }
    end += suffix.length;
  }
  for (let offset = chunkCursor; offset < cut; offset += cliChunkSize) {
    cliDeltas.push(cliText.slice(offset, Math.min(offset + cliChunkSize, cut)));
  }
  cliDeltas.push(...suffixChunks);
  chunkCursor = end;
}
for (let offset = chunkCursor; offset < cliText.length; offset += cliChunkSize) {
  cliDeltas.push(cliText.slice(offset, Math.min(offset + cliChunkSize, cliText.length)));
}
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-final-answer-proof-"));
const stateDir = path.join(tempRoot, "state");
const workspace = path.join(tempRoot, "workspace");
const configPath = path.join(tempRoot, "openclaw.json");
await Promise.all([mkdir(stateDir), mkdir(workspace)]);
let streamingRequests = 0;
let responseChunks = 0;

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const parsed = JSON.parse(body);
    if (parsed.stream !== true) {
      response.writeHead(400).end("streaming Responses request required");
      return;
    }
    streamingRequests += 1;
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    const writeEvent = (event: Record<string, unknown>) => {
      responseChunks += 1;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const item = {
      id: "msg_local_proof",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: cliText, annotations: [] }],
    };
    writeEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: item.id, type: item.type, role: item.role, phase: item.phase, content: [] },
    });
    writeEvent({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const delta of cliDeltas) {
      writeEvent({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta,
      });
    }
    writeEvent({ type: "response.output_item.done", output_index: 0, item });
    writeEvent({
      type: "response.completed",
      response: {
        id: "resp_local_proof",
        status: "completed",
        model: "stream-proof",
        output: [item],
        usage: { input_tokens: 1, output_tokens: cliText.length, total_tokens: cliText.length + 1 },
      },
    });
    response.end();
  });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback Responses provider did not bind a TCP port");
  }
  const config = {
    agents: {
      defaults: {
        contextInjection: "never",
        model: { primary: "openai/stream-proof" },
        workspace,
      },
    },
    models: {
      mode: "merge",
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              contextWindow: 16_384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: "stream-proof",
              input: ["text"],
              maxTokens: 8_192,
              name: "Local streaming proof",
              reasoning: false,
            },
          ],
        },
      },
    },
    tools: { profile: "minimal" },
  };
  await writeFile(configPath, JSON.stringify(config));

  const env = {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    OPENAI_API_KEY: "local-proof-key",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROFILE: "proof-175328",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VITEST_RUNTIME: "node",
    PATH: process.env.PATH,
    npm_config_manage_package_manager_versions: "false",
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "src/entry.ts"),
      "agent",
      "exec",
      "Return the streamed content exactly.",
      "--model",
      "openai/stream-proof",
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--cwd",
      workspace,
      "--code-mode",
      "direct",
      "--timeout",
      "90",
      "--json",
    ],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`agent exec exited ${exitCode}: ${`${stdout}\n${stderr}`.slice(-4000)}`);
  }
  const result = JSON.parse(stdout.trim());
  const finalText = typeof result.final === "string" ? result.final : "";
  const expectedFinal = sanitizeAssistantVisibleStreamText(cliText, "final_answer");
  const observations = {
    status: result.status,
    streamingRequests,
    finalLength: finalText.length,
    expectedLength: expectedFinal.length,
    matchesCanonical: finalText === expectedFinal,
    pendingPayloadPresent: finalText.includes('[tool:write]\n{"path":"notes.txt"'),
    imageCallPresent: finalText.includes("![example `x\n[tool:read] {}\nx` label](/url)"),
    titleCallPresent: finalText.includes(
      '[title]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n"',
    ),
    inlineLinkTitleCallPresent: finalText.includes(inlineLinkTitlePrefix),
    balancedDestinationTitleCallPresent: finalText.includes(balancedDestinationTitlePrefix),
    multilineDestinationTitleCallPresent: finalText.includes(multilineDestinationTitlePrefix),
    blockquoteTitleCallPresent: finalText.includes(blockquoteTitlePrefix),
    nestedBlockquoteTitleCallPresent: finalText.includes(nestedBlockquoteTitlePrefix),
    parenthesizedLinkTitleCallPresent: finalText.includes(parenthesizedLinkTitlePrefix),
    lateIndentedCallPresent: finalText.includes('    [tool:write] {"path":"late-indent.txt"}'),
    longReferenceImageCallPresent: finalText.includes("![example `x\n[tool:read] {}\nx`][long]"),
    referenceCallPresent: finalText.includes("![example `x\n[tool:read] {}\nx`][next]"),
    listReferenceCallPresent: finalText.includes("![example `x\n[tool:read] {}\nx`][list]"),
    indentedCallsPreserved: finalText.includes("    [tool:read] {}\n    [tool:write] {}"),
    listFenceCallsPreserved: finalText.includes("- ```text\n  [tool:read] {}\n  [tool:write] {}"),
    fencedControlPreserved: finalText.includes('```text\n[tool:read] {"path":"example.txt"}\n```'),
  };
  console.log(JSON.stringify({ case: "agent exec final-answer observations", ...observations }));
  if (
    result.status !== "ok" ||
    streamingRequests !== 1 ||
    !observations.matchesCanonical ||
    observations.pendingPayloadPresent ||
    observations.imageCallPresent ||
    observations.titleCallPresent ||
    observations.referenceCallPresent ||
    observations.listReferenceCallPresent ||
    observations.inlineLinkTitleCallPresent ||
    observations.balancedDestinationTitleCallPresent ||
    observations.multilineDestinationTitleCallPresent ||
    observations.blockquoteTitleCallPresent ||
    observations.nestedBlockquoteTitleCallPresent ||
    observations.parenthesizedLinkTitleCallPresent ||
    !observations.lateIndentedCallPresent ||
    observations.longReferenceImageCallPresent ||
    !observations.indentedCallsPreserved ||
    !observations.listFenceCallsPreserved ||
    !observations.fencedControlPreserved
  ) {
    throw new Error(
      `OpenClaw agent exec did not meet the final-answer stream contract: ${JSON.stringify(observations)}`,
    );
  }
  console.log("entrypoint: openclaw agent exec via src/entry.ts");
  console.log("provider: one local OpenAI Responses SSE request");
  console.log("phase: final_answer");
  console.log(
    `pending-call workload: 4,096 payload characters in ${cliChunkSize}-character deltas`,
  );
  console.log(
    `response events: ${responseChunks}; tool-call deltas: ${Math.ceil(pendingCall.length / cliChunkSize)}`,
  );
  console.log(
    `inline-link title transition: ${expectInlineLinkTitleLeak ? "stream projection leak reproduced; final snapshot canonical" : "tool-call hidden"}`,
  );
  console.log(
    "quoted-title transitions after balanced and multiline destinations: tool-call hidden",
  );
  console.log(
    `late indentation-only line transition: literal code call ${observations.lateIndentedCallPresent ? "preserved" : "lost"}`,
  );
  console.log("long reference destination transition: image-alt call hidden");
  console.log(
    `parenthesized inline-link title transition: ${expectParenthesizedLinkTitleLeak ? "stream projection leak reproduced; final snapshot canonical" : "tool-call hidden"}`,
  );
  console.log(
    "result: resolved link/image/reference calls hidden; list, indented, and fenced code calls preserved",
  );
  console.log(`status: ${result.status}`);
} finally {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await rm(tempRoot, { recursive: true, force: true });
}
