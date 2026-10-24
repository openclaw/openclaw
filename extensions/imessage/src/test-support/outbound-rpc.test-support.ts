import fs from "node:fs";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
import { imessagePlugin } from "../channel.js";

type RpcRequest = {
  method: string;
  params: {
    text: string;
    formatting?: Array<{ start: number; length: number; styles: string[] }>;
  };
};

export const roles = ["user", "system", "assistant"] as const;
export const hiddenFunctionResponse = `<function_calls><invoke name="exec">HIDDEN_FUNCTION_CALL</invoke></function_calls><function_response>
HIDDEN_FUNCTION_RESPONSE
</function_response>`;
export const privateRuntimeBlocks = [
  "<system-reminder>\nuser:\nHIDDEN_RUNTIME_REMINDER\n\ue000\n</system-reminder>",
  "< previous_response origin='runtime'>HIDDEN_RUNTIME_PREVIOUS\ue001< / previous_response >",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>HIDDEN_RUNTIME_CONTEXT\ue002<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  "<system-reminder><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_REMINDER\ue003</system-reminder>",
  "<previous_response><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_MIXED\ue004</previous_response>",
  "< SYSTEM-REMINDER>< previous_response origin='runtime'>inner< / previous_response >HIDDEN_RUNTIME_NESTED_CASE\ue005< / SYSTEM-REMINDER >",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_CONTEXT\ue006<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  // Exhaustive parser variants live in monitor/sanitize-outbound.test-support.ts.
  "<system-reminder data-x='>'>HIDDEN_RUNTIME_QUOTED</system-reminder>",
  "<system-reminder><!-- </system-reminder> <system-reminder> -->HIDDEN_RUNTIME_OPAQUE_COMMENT</system-reminder>",
  '<previous_response><?private fake="?> </previous_response>"?>HIDDEN_RUNTIME_OPAQUE_INSTRUCTION</previous_response>',
  "<previous_response>`</system-reminder>`HIDDEN_RUNTIME_CODE_INLINE</previous_response>",
  '<system-reminder><script title=">"></system-reminder></script>HIDDEN_RUNTIME_RAW_TEXT</system-reminder>',
  '<previous_response><TEXTAREA data-x=">" /></previous_response></textarea>HIDDEN_RUNTIME_RAW_TEXT_SELF_CLOSING</previous_response>',
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
  sendMessageIMessage: typeof import("../send.js").sendMessageIMessage,
) {
  const cliPath = openClawState.path("fake-imsg");
  const requestLogPath = openClawState.path("fake-imsg-requests.jsonl");
  const actionLogPath = openClawState.path("fake-imsg-actions.jsonl");
  fs.writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const requestLogPath = ${JSON.stringify(requestLogPath)};
const actionLogPath = ${JSON.stringify(actionLogPath)};
const args = process.argv.slice(2);
if (args.join(" ") === "rpc --json") {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    fs.appendFileSync(requestLogPath, line + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id, result: { guid: "p:0/imsg-rpc-proof", status: "sent" }
    }) + "\\n");
  });
} else {
  fs.appendFileSync(actionLogPath, JSON.stringify(args) + "\\n");
  if (args.includes("--file") && !fs.existsSync(args[args.indexOf("--file") + 1])) {
    process.exit(3);
  }
  const pollOptions = args
    .flatMap((arg, index) => arg === "--option" ? [args[index + 1]] : [])
    .map((text, index) => ({ id: \`option-\${index}\`, text }));
  process.stdout.write(JSON.stringify({ guid: "p:0/imsg-action-proof", poll: { options: pollOptions } }) + "\\n");
}`,
    { mode: 0o755 },
  );
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VITEST", "");
  fs.writeFileSync(requestLogPath, "");
  fs.writeFileSync(actionLogPath, "");
  const cfg = { channels: { imessage: { accounts: { default: { cliPath } } } } };
  const readLog = <T>(file: string): T[] => {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as T);
  };
  const readRequests = () => readLog<RpcRequest>(requestLogPath);
  return {
    cfg,
    actionOptions: { cliPath, chatGuid: "iMessage;+;chat0000" },
    requestLogPath,
    readRequests,
    readActions: () => readLog<string[]>(actionLogPath),
    countNativeRequests: () => readRequests().length,
    deliver: async (text: string, textLimit = 4000) => {
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
    },
    createChannelDelivery: () => {
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
    },
  };
}

export function expectScrubbedRequests(requests: RpcRequest[]) {
  for (const request of requests) {
    expect(request.params.text).not.toContain("#+#+#");
    expect(request.params.text).not.toMatch(/HIDDEN_(?:RPC|FUNCTION|RUNTIME)_/);
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
