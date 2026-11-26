import { addAbortListener } from "node:events";
import {
  closeOwnedStdioProcess,
  createBoundedLineFramer,
  createOwnedStdioProcess,
  type OwnedStdioProcessOptions,
} from "openclaw/plugin-sdk/process-runtime";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * MAX_FRAME_BYTES;
const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export type AgyUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  thinking?: number;
  total?: number;
};

type AgyInit = { conversationId: string; acknowledgedModel: string };
export type AgyTurnResult = AgyInit & {
  text: string;
  turnUsage: AgyUsage | undefined;
};

type AgyFrame =
  | { kind: "init"; id: string; model: string }
  | { kind: "step"; id: string; delta?: string; usage?: AgyUsage }
  | { kind: "terminal"; id: string; successful: boolean; text: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Antigravity protocol object.");
  }
  return value as Record<string, unknown>;
}

export function isAgyConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

function conversationId(value: unknown): string {
  if (!isAgyConversationId(value)) {
    throw new Error("Invalid Antigravity conversation identity.");
  }
  return value;
}

function stepUsage(raw: unknown): AgyUsage | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const data = record(raw);
  const usage: AgyUsage = {};
  for (const [key, field] of [
    ["input", "input_tokens"],
    ["output", "output_tokens"],
    ["cacheRead", "cache_read_tokens"],
    ["thinking", "thinking_tokens"],
    ["total", "total_tokens"],
  ] as const) {
    const value = data[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      usage[key] = value;
    }
  }
  return Object.keys(usage).length ? usage : undefined;
}

function decodeFrame(line: Buffer): AgyFrame {
  let json: unknown;
  try {
    json = JSON.parse(line.toString("utf8"));
  } catch {
    // Parser messages can contain raw transport data, including user content.
    throw new Error("Invalid Antigravity NDJSON frame.");
  }
  const value = record(json);
  switch (value.event) {
    case "init": {
      const init = record(value.init);
      if (typeof init.model !== "string" || !init.model) {
        throw new Error("Antigravity did not acknowledge a model selection.");
      }
      return { kind: "init", id: conversationId(value.conversation_id), model: init.model };
    }
    case "step_update": {
      const step = record(value.step_update);
      const id = conversationId(step.conversation_id);
      // Native tool metadata is not a host authorization or a trusted event source.
      if (step.step_type !== "agent_response") {
        return { kind: "step", id };
      }
      return {
        kind: "step",
        id,
        delta: typeof step.text_delta === "string" ? step.text_delta : undefined,
        usage: step.state === "DONE" ? stepUsage(step.usage) : undefined,
      };
    }
    case "result": {
      const result = record(value.result);
      if (typeof result.response !== "string" && result.status === "SUCCESS") {
        throw new Error("Antigravity returned a successful result without response text.");
      }
      // The terminal usage field can aggregate previous turns; never bill it as current usage.
      return {
        kind: "terminal",
        id: conversationId(result.conversation_id),
        successful: result.status === "SUCCESS",
        text: typeof result.response === "string" ? result.response : "",
      };
    }
    default:
      throw new Error("Unexpected Antigravity protocol event.");
  }
}

type RunAgyTurnOptions = {
  /** Host-admitted, isolated launch. This module owns the wire, not native tool authority. */
  launch: Pick<OwnedStdioProcessOptions, "argv" | "cwd"> & { env: NodeJS.ProcessEnv };
  requestedModel: string;
  expectedConversationId?: string;
  prompt: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** Persist the verified native cursor using the admitted OpenClaw session owner. */
  bindConversation: (init: Readonly<AgyInit>) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
};

/** The transport never sends input until both the native cursor and selection are acknowledged. */
export async function runAgyTurn(options: RunAgyTurnOptions): Promise<AgyTurnResult> {
  const message = JSON.stringify({ event: "user", message: { content: options.prompt } }) + "\n";
  if (Buffer.byteLength(message) > MAX_FRAME_BYTES) {
    throw new Error("Antigravity input exceeds the native turn size limit.");
  }
  const child = await createOwnedStdioProcess({
    ...options.launch,
    exactEnv: true,
    terminateOnHostLoss: true,
    abortSignal: options.signal,
    assertCurrent: options.assertCurrent,
    stdoutConsumption: "awaited",
  });
  // Spawn admission only observes cancellation until the child is ready. A
  // native tool can keep stdout silent, so stop the owned tree independently.
  using lifetime = new DisposableStack();
  lifetime.use(addAbortListener(options.signal, () => child.kill("SIGKILL")));
  const framer = createBoundedLineFramer(MAX_FRAME_BYTES, "Antigravity output frame is too large.");
  let outputBytes = 0;
  // More than one inference step makes attribution ambiguous until step and checkpoint scope
  // are qualified. Report one terminal agent-response step only, never a guessed aggregate.
  let usageSteps = 0;
  let usage: AgyUsage | undefined;
  let init: AgyInit | undefined;
  let terminal: Extract<AgyFrame, { kind: "terminal" }> | undefined;
  let completed = false;
  try {
    options.signal.throwIfAborted();
    await child.consumeStdout(async (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        throw new Error("Antigravity output exceeds the native turn size limit.");
      }
      for (const line of framer.push(buffer)) {
        options.signal.throwIfAborted();
        const frame = decodeFrame(line);
        if (terminal) {
          throw new Error("Antigravity emitted output after the terminal result.");
        }
        if (!init) {
          if (frame.kind !== "init") {
            throw new Error("Antigravity did not initialize before producing turn output.");
          }
          if (options.expectedConversationId && frame.id !== options.expectedConversationId) {
            throw new Error(
              "Antigravity did not resume the exact conversation. Start a new session explicitly.",
            );
          }
          if (frame.model !== options.requestedModel) {
            throw new Error("Antigravity did not acknowledge the requested model.");
          }
          init = { conversationId: frame.id, acknowledgedModel: frame.model };
          if (!child.stdin) {
            throw new Error("Antigravity did not open a prompt pipe.");
          }
          const stdin = child.stdin;
          await options.bindConversation(init);
          options.signal.throwIfAborted();
          options.assertCurrent();
          await new Promise<void>((resolve, reject) => {
            stdin.write(message, (error) => (error ? reject(error) : resolve()));
          });
          stdin.end();
        } else {
          if (frame.kind === "init" || frame.id !== init.conversationId) {
            throw new Error("Antigravity changed conversation identity during the turn.");
          }
          if (frame.kind === "terminal") {
            terminal = frame;
          } else {
            if (frame.usage) {
              usage = frame.usage;
              usageSteps += 1;
            }
            if (frame.delta) {
              await options.onDelta?.(frame.delta);
            }
          }
        }
      }
    });
    options.signal.throwIfAborted();
    const exit = await child.wait();
    if (framer.pendingByteLength || !init || !terminal) {
      throw new Error("Antigravity exited before returning a complete native result.");
    }
    if (exit.code !== 0 || exit.signal || !terminal.successful) {
      throw new Error("Antigravity did not complete the native turn successfully.");
    }
    completed = true;
    return { ...init, text: terminal.text, turnUsage: usageSteps === 1 ? usage : undefined };
  } finally {
    // A resolved close has joined descendant extinction. Forced relay retirement
    // after that confirmation is diagnostic, not a failed Antigravity turn.
    await closeOwnedStdioProcess(child, { force: !completed });
  }
}
