import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";

type Event = {
  kind: "user" | "call" | "result";
  value: unknown;
  id?: string;
  name?: string;
  error?: boolean;
};
// Azure and subscription-specific transports need their own final-I/O custody proof.
// Keep ordinary OpenAI-compatible Responses (including configured OCI routes).
export const QUOTA_CONTINUATION_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error("Continuation contains unknown model content");
  }
  return value
    .map((part) => {
      const block = asRecord(part);
      if (
        !block ||
        !["text", "input_text", "output_text", "toolResult"].includes(String(block.type)) ||
        typeof block.text !== "string"
      ) {
        throw new Error("Continuation cannot transfer non-text or opaque model content");
      }
      return block.text;
    })
    .join("\n");
}

function argumentsValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function sourceEvents(messages: readonly unknown[]): Event[] {
  const events: Event[] = [];
  for (const messageValue of messages) {
    const message = asRecord(messageValue);
    if (message?.role === "user") {
      events.push({ kind: "user", value: text(message.content) });
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = asRecord(value);
        if (
          block?.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          events.push({ kind: "call", id: block.id, name: block.name, value: block.arguments });
        }
      }
    }
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      events.push({
        kind: "result",
        id: message.toolCallId,
        name: String(message.toolName),
        value: text(message.content),
        error: message.isError === true,
      });
    }
  }
  return events;
}

/** Inspect the final post-hook provider body, not an earlier storage or assembly view. */
function payloadEvents(payload: unknown, api: string): Event[] {
  const body = asRecord(payload);
  const rows = api.includes("responses") ? body?.input : body?.messages;
  if (!Array.isArray(rows)) {
    throw new Error("Continuation provider did not expose its final message body");
  }
  const events: Event[] = [];
  for (const rowValue of rows) {
    const row = asRecord(rowValue);
    if (!row) {
      throw new Error("Malformed continuation provider message");
    }
    if (row.type === "function_call") {
      if (typeof row.call_id !== "string" || typeof row.name !== "string") {
        throw new Error("Malformed function call");
      }
      events.push({
        kind: "call",
        id: row.call_id,
        name: row.name,
        value: argumentsValue(row.arguments),
      });
      continue;
    }
    if (row.type === "function_call_output") {
      if (typeof row.call_id !== "string") {
        throw new Error("Malformed function result");
      }
      events.push({ kind: "result", id: row.call_id, value: text(row.output) });
      continue;
    }
    if (
      (row.type !== undefined && row.type !== "message") ||
      !["user", "assistant", "system", "developer", "tool"].includes(String(row.role))
    ) {
      throw new Error("Quota continuation contains an opaque provider message or reference");
    }
    if (row.role === "tool") {
      if (typeof row.tool_call_id !== "string") {
        throw new Error("Malformed tool result");
      }
      events.push({ kind: "result", id: row.tool_call_id, value: text(row.content) });
      continue;
    }
    if (Array.isArray(row.tool_calls)) {
      for (const value of row.tool_calls) {
        const call = asRecord(value);
        const fn = asRecord(call?.function);
        if (typeof call?.id !== "string" || typeof fn?.name !== "string") {
          throw new Error("Malformed tool call");
        }
        events.push({
          kind: "call",
          id: call.id,
          name: fn.name,
          value: argumentsValue(fn.arguments),
        });
      }
    }
    if (row.content == null) {
      continue;
    }
    if (typeof row.content === "string") {
      if (row.role === "user") {
        events.push({ kind: "user", value: row.content });
      }
      continue;
    }
    if (!Array.isArray(row.content)) {
      throw new Error("Unknown continuation content");
    }
    const userText: unknown[] = [];
    for (const value of row.content) {
      const block = asRecord(value);
      if (
        block?.type === "tool_use" &&
        row.role === "assistant" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        events.push({ kind: "call", id: block.id, name: block.name, value: block.input });
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        events.push({
          kind: "result",
          id: block.tool_use_id,
          value: text(block.content),
          error: block.is_error === true,
        });
      } else if (
        block?.type === "thinking" &&
        typeof block.thinking === "string" &&
        row.role === "assistant"
      ) {
        // Destination policy, not custody, owns portable reasoning projection.
      } else {
        text([value]); // Reject newly materialized media even outside the required suffix.
        if (row.role === "user") {
          userText.push(value);
        }
      }
    }
    if (userText.length) {
      events.push({ kind: "user", value: text(userText) });
    }
  }
  return events;
}

export type QuotaContextInventory = {
  before: readonly unknown[];
  after: readonly unknown[];
};

/** Compare the complete owned occurrence inventory, including older identical requests.
 * The three-argument structural check admits only the source and one distinct trailing
 * instruction; production supplies the exact host-owned instruction and successor facts.
 */
export function assertQuotaPrefixInProviderPayload(
  required: readonly unknown[],
  payload: unknown,
  api: string,
  inventory?: QuotaContextInventory,
): void {
  if (!QUOTA_CONTINUATION_APIS.has(api)) {
    throw new Error("Quota continuation has no final-payload contract for this API");
  }
  const source = sourceEvents(required);
  const expected = inventory
    ? [...sourceEvents(inventory.before), ...source, ...sourceEvents(inventory.after)]
    : source;
  const actual = payloadEvents(payload, api);
  if (source[0]?.kind !== "user" || source.length < 3) {
    throw new Error("Missing required admitted prefix");
  }
  const userText = (value: unknown) => stripInboundMetadata(String(value)).trim();
  const matchesUser = (original: string, projected: string) =>
    projected === original || projected.startsWith(`${original}\n\nRuntime: `);
  const last = actual.at(-1);
  if (
    !inventory &&
    last?.kind === "user" &&
    !matchesUser(userText(source[0].value), userText(last.value))
  ) {
    actual.pop();
  }
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const valid =
    expected.length === actual.length &&
    expected.every((want, offset) => {
      const have = actual[offset];
      if (!have || have.kind !== want.kind) {
        return false;
      }
      if (want.kind === "user") {
        // IDs can be reused by an older turn. Its owned occurrence is distinct;
        // the provider must still give every projected call a unique wire ID.
        ids.clear();
        const original = userText(want.value);
        const projected = userText(have.value);
        return matchesUser(original, projected);
      }
      if (want.kind === "call") {
        if (
          !want.id ||
          !have.id ||
          ids.has(want.id) ||
          used.has(have.id) ||
          want.name !== have.name ||
          !isDeepStrictEqual(want.value, have.value)
        ) {
          return false;
        }
        ids.set(want.id, have.id);
        used.add(have.id);
        return true;
      }
      if (!want.id || !have.id || ids.get(want.id) !== have.id || (have.error && !want.error)) {
        return false;
      }
      if (want.value === have.value) {
        return true;
      }
      // The native mirror's ordinary provider codec may serialize the whole text block.
      try {
        const block = asRecord(JSON.parse(String(have.value)));
        return (
          block?.type === "toolResult" &&
          block.text === want.value &&
          block.content === want.value &&
          ["id", "toolCallId", "toolUseId", "tool_use_id"].every(
            (key) => block[key] === want.id || block[key] === have.id,
          ) &&
          ["name", "toolName"].every((key) => block[key] === want.name)
        );
      } catch {
        return false;
      }
    });
  if (!valid) {
    throw new Error(
      "Quota continuation lost or duplicated its required admitted user/tool prefix before provider dispatch",
    );
  }
}

/** Private successor facts are supplied by the concrete loop hooks, never provider context.
 * Compare durable suffix frames against them before admitting any new round to the wire.
 */
export function createQuotaSuccessorInventory() {
  const receipts = new Map<
    string,
    { name: string; args: unknown; output: string; error: boolean; executed: boolean }
  >();
  let invalid = false;
  return {
    record: (context: {
      toolCall: { id: string; name: string };
      args: unknown;
      result: { content: unknown };
      isError: boolean;
      executionStarted?: boolean;
    }) => {
      try {
        const { toolCall, args, result, isError } = context;
        if (receipts.has(toolCall.id)) {
          invalid = true;
          return;
        }
        receipts.set(toolCall.id, {
          name: toolCall.name,
          args: structuredClone(args),
          output: text(result.content),
          error: isError,
          executed: context.executionStarted !== false,
        });
      } catch {
        invalid = true;
      }
    },
    assert(messages: readonly unknown[]) {
      const durableCalls = new Set(
        sourceEvents(messages)
          .filter((event) => event.kind === "call")
          .map((event) => event.id),
      );
      // Normal persistence omits unavailable calls. Only a loop-observed no-start
      // failure may supply that validation-only call; never invent a completion.
      const projected = messages.flatMap((message) => {
        const row = asRecord(message);
        const id = row?.toolCallId;
        const receipt = typeof id === "string" ? receipts.get(id) : undefined;
        return typeof id === "string" &&
          row?.role === "toolResult" &&
          receipt?.executed === false &&
          receipt.error &&
          !durableCalls.has(id)
          ? [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id,
                    name: receipt.name,
                    arguments: structuredClone(receipt.args),
                  },
                ],
              },
              message,
            ]
          : [message];
      });
      const calls = new Set<string>();
      const results = new Set<string>();
      for (const event of sourceEvents(projected)) {
        const receipt = event.id ? receipts.get(event.id) : undefined;
        if (!receipt || !event.id || event.kind === "user") {
          throw new Error("Quota continuation has unowned successor context");
        }
        if (event.kind === "call") {
          if (
            calls.has(event.id) ||
            receipt.name !== event.name ||
            !isDeepStrictEqual(receipt.args, event.value)
          ) {
            throw new Error("Quota continuation successor call changed");
          }
          calls.add(event.id);
        } else {
          if (
            !calls.has(event.id) ||
            results.has(event.id) ||
            receipt.name !== event.name ||
            receipt.output !== event.value ||
            receipt.error !== event.error
          ) {
            throw new Error("Quota continuation successor result changed");
          }
          results.add(event.id);
        }
      }
      if (invalid || calls.size !== receipts.size || results.size !== receipts.size) {
        throw new Error("Quota continuation successor inventory is incomplete");
      }
      return projected;
    },
  };
}
