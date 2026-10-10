import fs from "node:fs";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
import { imessagePlugin } from "../channel.js";

type SendMessage = typeof import("../send.js").sendMessageIMessage;
type RpcRequest = {
  method: string;
  params: {
    text: string;
    formatting?: Array<{ start: number; length: number; styles: string[] }>;
  };
};

export const roles = ["user", "system", "assistant"] as const;
export const hiddenFunctionResponse = [
  '<function_calls><invoke name="exec">HIDDEN_FUNCTION_CALL</invoke></function_calls><function_response>',
  "HIDDEN_FUNCTION_RESPONSE",
  "</function_response>",
].join("\n");
export const privateRuntimeBlocks = [
  "<system-reminder>\nuser:\nHIDDEN_RUNTIME_REMINDER\n\ue000\n</system-reminder>",
  "< previous_response origin='runtime'>HIDDEN_RUNTIME_PREVIOUS\ue001< / previous_response >",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>HIDDEN_RUNTIME_CONTEXT\ue002<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  "<system-reminder><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_REMINDER\ue003</system-reminder>",
  "<previous_response><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_MIXED\ue004</previous_response>",
  "< SYSTEM-REMINDER>< previous_response origin='runtime'>inner< / previous_response >HIDDEN_RUNTIME_NESTED_CASE\ue005< / SYSTEM-REMINDER >",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_CONTEXT\ue006<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ...(["system-reminder", "previous_response"] as const).flatMap((name) =>
    ["'", '"'].flatMap((quote) =>
      [">", "/>"].map(
        (attribute) =>
          `<${name} data-x=${quote}${attribute}${quote}>HIDDEN_RUNTIME_QUOTED</${name}>`,
      ),
    ),
  ),
  ...(["system-reminder", "previous_response"] as const).flatMap((name) => [
    `<${name}><!-- </${name}> <${name}> -->HIDDEN_RUNTIME_OPAQUE_COMMENT</${name}>`,
    `<${name}><![CDATA[</${name}> <${name}>]]>HIDDEN_RUNTIME_OPAQUE_CDATA</${name}>`,
    `<${name}><!DOCTYPE message [ <!ENTITY hidden "</${name}>"> ]>HIDDEN_RUNTIME_OPAQUE_DECLARATION</${name}>`,
    `<${name}><?private fake="?> </${name}>"?>HIDDEN_RUNTIME_OPAQUE_INSTRUCTION</${name}>`,
    `<${name}><! </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS</${name}>`,
    `<${name}><! <${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_OPEN</${name}>`,
    `<${name}></! </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_CLOSE</${name}>`,
    `<${name}></? </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_QUESTION</${name}>`,
    `<${name}></1 </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_NUMBER</${name}>`,
    `<${name}></ </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_SPACE</${name}>`,
  ]),
  ...(["system-reminder", "previous_response"] as const).flatMap((outer) =>
    (["system-reminder", "previous_response"] as const).flatMap((inner) => [
      `<${outer}>\`</${inner}>\`HIDDEN_RUNTIME_CODE_INLINE</${outer}>`,
      `<${outer}>\n\`\`\`xml\n</${inner}>\n\`\`\`\nHIDDEN_RUNTIME_CODE_FENCED</${outer}>`,
      `<${outer}>\n\n    </${inner}>\nHIDDEN_RUNTIME_CODE_INDENTED</${outer}>`,
    ]),
  ),
  ...(["system-reminder", "previous_response"] as const).flatMap((name) =>
    [
      "script",
      "style",
      "textarea",
      "title",
      "xmp",
      "iframe",
      "noembed",
      "noframes",
      "noscript",
    ].flatMap((rawText) => [
      `<${name}><${rawText} title=">"></${name}></${rawText}>HIDDEN_RUNTIME_RAW_TEXT</${name}>`,
      `<${name}><${rawText.toUpperCase()} data-x=">" /></${name}></${rawText}>HIDDEN_RUNTIME_RAW_TEXT_SELF_CLOSING</${name}>`,
    ]),
  ),
] as const;
export const privateRuntimeScaffolding = privateRuntimeBlocks
  .flatMap((block, index) =>
    index < 7 ? [block, `\`${block}\``, `\`\`\`xml\n${block}\n\`\`\``] : [block],
  )
  .join("\n");
export const nestMarkdownFences = (source: string, depth: number): string => {
  let nested = source;
  for (let layer = 0; layer < depth; layer += 1) {
    const fence = "`".repeat(layer + 3);
    nested = `${fence}xml\n${nested}\n${fence}`;
  }
  return nested;
};

export const rawSeparator = "#+#+#";
export const entitySeparator = "&#35;&#43;&#35;&#43;&#35;";
export const fencedYaml = ["```yaml", ...roles.map((role) => `${role}:`), "```"].join("\n");

// Keep the native RPC and CLI action boundaries; only the executable is synthetic.
export function createIMessageOutboundRpcFixture(
  openClawState: OpenClawTestState,
  sendMessageIMessage: SendMessage,
) {
  const cliPath = openClawState.path("fake-imsg");
  const requestLogPath = openClawState.path("fake-imsg-requests.jsonl");
  const actionLogPath = openClawState.path("fake-imsg-actions.jsonl");
  fs.writeFileSync(
    cliPath,
    [
      "#!" + process.execPath,
      'const fs = require("node:fs");',
      'const readline = require("node:readline");',
      "const requestLogPath = " + JSON.stringify(requestLogPath) + ";",
      "const actionLogPath = " + JSON.stringify(actionLogPath) + ";",
      "const args = process.argv.slice(2);",
      'if (args.join(" ") === "rpc --json") {',
      '  readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      "    const request = JSON.parse(line);",
      '    fs.appendFileSync(requestLogPath, line + "\\n");',
      "    process.stdout.write(JSON.stringify({",
      '      jsonrpc: "2.0", id: request.id,',
      '      result: { guid: "p:0/imsg-rpc-proof", status: "sent" }',
      '    }) + "\\n");',
      "  });",
      "} else {",
      '  fs.appendFileSync(actionLogPath, JSON.stringify(args) + "\\n");',
      '  if (args.includes("--file") && !fs.existsSync(args[args.indexOf("--file") + 1])) {',
      "    process.exit(3);",
      "  }",
      "  const pollOptions = [];",
      "  for (let index = 0; index < args.length; index += 1) {",
      '    if (args[index] === "--option") {',
      "      pollOptions.push({ id: `option-${pollOptions.length}`, text: args[index + 1] });",
      "    }",
      "  }",
      "  process.stdout.write(JSON.stringify({",
      '    guid: "p:0/imsg-action-proof", poll: { options: pollOptions }',
      '  }) + "\\n");',
      "}",
    ].join("\n"),
    { mode: 0o755 },
  );
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VITEST", "");
  fs.writeFileSync(requestLogPath, "");
  fs.writeFileSync(actionLogPath, "");
  const cfg = { channels: { imessage: { accounts: { default: { cliPath } } } } };
  const actionOptions = { cliPath, chatGuid: "iMessage;+;chat0000" };
  const readLines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const readRequests = (): RpcRequest[] =>
    readLines(requestLogPath).map((line) => JSON.parse(line) as RpcRequest);
  const readActions = (): string[][] =>
    readLines(actionLogPath).map((line) => JSON.parse(line) as string[]);
  const countNativeRequests = () => readRequests().length;
  const deliver = async (text: string, textLimit = 4000) => {
    const { deliverIMessageReply } = await import("../monitor/deliver.js");
    return await deliverIMessageReply({
      cfg,
      payload: { text },
      target: "chat_id:10",
      accountId: "default",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      maxBytes: 4096,
      textLimit,
    });
  };
  const createChannelDelivery = () => {
    // The registered renderers are stateless; share them across per-case module resets.
    const channelChunker = imessagePlugin.outbound?.chunker;
    const channelSanitizer = imessagePlugin.outbound?.sanitizeText;
    if (!channelChunker || !channelSanitizer) {
      throw new Error("Expected the iMessage outbound Markdown sanitizer and chunker");
    }
    expect(imessagePlugin.outbound?.chunkerMode).toBe("markdown");

    const deliverThroughChannel = async (source: string, limit = 4000) => {
      const sanitized = channelSanitizer({ text: source, payload: { text: source } });
      const chunks = channelChunker(sanitized, limit);
      for (const chunk of chunks) {
        await sendMessageIMessage("chat_id:10", chunk, { config: cfg });
      }
      return { sanitized, chunks };
    };
    return { channelChunker, channelSanitizer, deliverThroughChannel };
  };
  return {
    cfg,
    actionOptions,
    requestLogPath,
    readRequests,
    readActions,
    countNativeRequests,
    deliver,
    createChannelDelivery,
  };
}

export function expectScrubbedRequests(requests: RpcRequest[]) {
  for (const request of requests) {
    expect(request.params.text).not.toContain("#+#+#");
    expect(request.params.text).not.toContain("HIDDEN_RPC_");
    expect(request.params.text).not.toContain("HIDDEN_FUNCTION_");
    expect(request.params.text).not.toContain("HIDDEN_RUNTIME_");
    expect(request.params.text).not.toMatch(/system-reminder|previous_response|INTERNAL_CONTEXT/i);
    expect(request.params.text).not.toMatch(/<(?:thinking|relevant[-_]memories)\b/i);
    expect(request.params.text).not.toMatch(/assistant\s+to\s*=\s*\w+/i);
    expect(request.params.text).not.toMatch(/[\ue000-\uf8ff]/);
    for (const range of request.params.formatting ?? []) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.start + range.length).toBeLessThanOrEqual(request.params.text.length);
    }
  }
}

export function expectNoRoleMarkers(requests: RpcRequest[]) {
  for (const request of requests) {
    expect(request.params.text).not.toMatch(/^[ \t]*(?:user|system|assistant):[ \t]*$/gim);
  }
}
