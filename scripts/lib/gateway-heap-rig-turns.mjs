import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

function toolEvents(callId, code) {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "exec",
    arguments: JSON.stringify({ title: "Exercise synthetic agent work", code, awaitResults: true }),
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

function assertTerminal(result, runId, marker, tool) {
  const receipt = result.terminalReceipt;
  if (
    result.runId !== runId ||
    result.status !== "ok" ||
    result.error ||
    result.pendingError ||
    result.yielded ||
    receipt?.runId !== runId ||
    !receipt.sessionId ||
    !receipt.turnId ||
    receipt.rerouted ||
    receipt.effective?.provider !== "openai" ||
    receipt.terminalDisposition !== "visible" ||
    result.terminalReply?.disposition !== "visible" ||
    result.terminalReply.text !== marker ||
    (tool && !receipt.successfulToolNames.includes("exec"))
  ) {
    throw new Error(`Synthetic turn terminal evidence failed: ${JSON.stringify(result)}`);
  }
  return receipt;
}

async function readCodeResult(requestLogPath, start, marker) {
  const end = (await stat(requestLogPath)).size;
  if (end <= start) {
    throw new Error("Mock provider recorded no request for the synthetic tool result");
  }
  const input = createReadStream(requestLogPath, { start, end: end - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = JSON.parse(line);
      if (typeof record.body !== "string") {
        continue;
      }
      const body = JSON.parse(record.body);
      for (const item of body.input ?? []) {
        if (item.type !== "function_call_output" || typeof item.output !== "string") {
          continue;
        }
        let output;
        try {
          output = JSON.parse(item.output);
        } catch {
          continue;
        }
        if (output.status === "completed" && output.value?.marker === marker) {
          return output.value;
        }
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  throw new Error(`Mock provider did not observe completed Code Mode output for ${marker}`);
}

/** Configure the existing mock OpenAI server; the driver owns launch and turn cadence. */
export async function configureHeapRigTurns(config, root, mockPort) {
  await mkdir(root, { recursive: true });
  const responseControlPath = path.join(root, "mock-turn-responses.json");
  const requestLogPath = path.join(root, "mock-turn-requests.jsonl");
  config.tools = { ...config.tools, codeMode: true };
  const evidence = [];
  let active = false;

  const writeControl = async (control) => {
    const temporary = `${responseControlPath}.tmp`;
    await writeFile(temporary, JSON.stringify(control));
    await rename(temporary, responseControlPath);
  };
  await writeControl({ text: "SYNTHETIC_HEAP_RIG_IDLE" });
  await writeFile(requestLogPath, "", { flag: "wx" });

  return {
    responseControlPath,
    requestLogPath,
    evidence,
    env: {
      MOCK_PORT: String(mockPort),
      MOCK_BIND_HOST: "127.0.0.1",
      MOCK_RESPONSE_CONTROL: responseControlPath,
      MOCK_REQUEST_LOG: requestLogPath,
    },
    async runTurn(rpc, index, options = {}) {
      if (active) {
        throw new Error("Synthetic heap-rig turns must run serially");
      }
      active = true;
      const startedAt = Date.now();
      const kind =
        options.kind ?? (index % 5 === 2 ? "subagent" : index % 5 === 1 ? "code" : "text");
      const agentId = options.agentId ?? (index % 2 === 0 ? "main" : "research");
      const sessionKey = options.sessionKey ?? `agent:${agentId}:heap-rig-turn-${index}`;
      const runId = randomUUID();
      const marker = `SYNTHETIC_HEAP_RIG_${runId}`;
      try {
        const logStart = (await stat(requestLogPath)).size;
        const code =
          kind === "subagent"
            ? `const child = await sessions_spawn(${JSON.stringify({
                task: `Reply with ${marker}.`,
                runtime: "subagent",
                context: "isolated",
                mode: "run",
                cleanup: "keep",
                expectsCompletionMessage: false,
                runTimeoutSeconds: 120,
                label: `Synthetic heap rig child ${index}`,
              })});\nreturn { marker: ${JSON.stringify(marker)}, child };`
            : `const values = Array.from({ length: 256 }, (_, index) => index * index);\nreturn { marker: ${JSON.stringify(marker)}, checksum: values.reduce((sum, value) => sum + value, 0) };`;
        // The first request consumes the tool fixture. Every continuation and child
        // gets final text; exact receipt/output checks detect another request stealing it.
        await writeControl({
          scriptVersion: runId,
          responses: kind === "text" ? [{ text: marker }] : [{ events: toolEvents(runId, code) }],
          default: { text: marker },
        });
        if (!options.canStart()) {
          return null;
        }
        const started = await rpc(
          "agent",
          {
            sessionKey,
            message: `Synthetic heap rig ${kind} turn ${index}. Reply with ${marker}.`,
            deliver: false,
            idempotencyKey: runId,
          },
          120_000,
        );
        if (started.runId !== runId || !["accepted", "ok"].includes(started.status)) {
          throw new Error(`Synthetic turn was not accepted: ${JSON.stringify(started)}`);
        }
        const completed = await rpc("agent.wait", { runId, timeoutMs: 180_000 }, 190_000);
        const receipt = assertTerminal(completed, runId, marker, kind !== "text");
        let child;
        if (kind !== "text") {
          const value = await readCodeResult(requestLogPath, logStart, marker);
          if (kind === "subagent") {
            child = value.child;
            if (child?.status !== "accepted" || !child.runId || !child.childSessionKey) {
              throw new Error(`Synthetic child was not accepted: ${JSON.stringify(child)}`);
            }
            const childCompleted = await rpc(
              "agent.wait",
              { runId: child.runId, timeoutMs: 180_000 },
              190_000,
            );
            assertTerminal(childCompleted, child.runId, marker, false);
          }
        }
        const result = {
          index,
          kind,
          runId,
          sessionKey,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          successfulToolNames: receipt.successfulToolNames,
          ...(child ? { childRunId: child.runId, childSessionKey: child.childSessionKey } : {}),
        };
        evidence.push(result);
        return result;
      } finally {
        active = false;
      }
    },
  };
}
