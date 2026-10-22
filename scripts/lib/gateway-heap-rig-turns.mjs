import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const TURN_KINDS = ["text", "code", "subagent", "artifact", "churn"];
const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

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

function assertTerminal(result, runId, reply, tool) {
  const receipt = result.terminalReceipt;
  // Lifecycle receipts cap text at 4096 characters; history owns the full reply.
  const terminalText = `${reply.slice(0, 4095).trimEnd()}…`;
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
    result.terminalReply.text !== terminalText ||
    (tool && !receipt.successfulToolNames.includes("exec"))
  ) {
    throw new Error(`Synthetic turn terminal evidence failed: ${JSON.stringify(result)}`);
  }
  return receipt;
}

function assertHistoryReply(messages, reply, label) {
  if (
    !messages?.some(
      (message) =>
        message.role === "assistant" &&
        (message.content === reply ||
          (Array.isArray(message.content) &&
            message.content.some((block) => block.type === "text" && block.text === reply))),
    )
  ) {
    throw new Error(`Synthetic reply missing from history for ${label}`);
  }
}

async function assertHistory(rpc, sessionKey, agentId, sessionId, reply) {
  const history = await rpc("chat.history", {
    sessionKey,
    agentId,
    limit: 20,
    maxBytes: 200_000,
    maxChars: 32_000,
  });
  if (history.sessionId !== sessionId) {
    throw new Error(`Synthetic history session changed: ${sessionKey} (${history.sessionId})`);
  }
  assertHistoryReply(history.messages, reply, `${sessionKey} (${sessionId})`);
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
  const sessionPool = new Map();
  const archivedSessions = [];
  const counts = {
    created: 0,
    hotSessions: 0,
    hotTurns: 0,
    archived: 0,
    archivedRetained: 0,
    deleted: 0,
    children: 0,
    artifacts: 0,
    cronRuns: 0,
    cronJobsRemoved: 0,
  };
  let active = false;

  const archiveSession = async (rpc, key, agentId, expectedSessionId) => {
    await rpc("sessions.patch", { key, agentId, expectedSessionId, archived: true });
    counts.archived++;
  };
  const deleteSession = async (rpc, key, agentId, expectedSessionId) => {
    const result = await rpc("sessions.delete", {
      key,
      agentId,
      expectedSessionId,
      archivedOnly: true,
      deleteTranscript: true,
    });
    if (result.deleted !== true || result.key !== key) {
      throw new Error(`Synthetic session cleanup failed: ${JSON.stringify(result)}`);
    }
    counts.deleted++;
  };
  const retireSession = async (rpc, key, agentId, expectedSessionId) => {
    await archiveSession(rpc, key, agentId, expectedSessionId);
    await deleteSession(rpc, key, agentId, expectedSessionId);
  };

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
    counts,
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
      const kind = options.kind ?? TURN_KINDS[index % TURN_KINDS.length];
      const hot = kind === "text";
      const tool = kind === "code" || kind === "subagent";
      const agentId = options.agentId ?? (index % 2 === 0 ? "main" : "second");
      const sessionSlot = hot
        ? `hot-${index % 8}`
        : kind === "churn"
          ? `churn-${index}`
          : `pool-${index % 32}`;
      const sessionKey = options.sessionKey ?? `agent:${agentId}:heap-rig-${sessionSlot}`;
      const runId = randomUUID();
      const marker = `SYNTHETIC_HEAP_RIG_${runId}`;
      const reply =
        `${marker}\n${"Synthetic analysis: inspect the request, perform the bounded task, verify the result, and report the observed outcome.\n".repeat(128)}`.slice(
          0,
          8191,
        ) + ".";
      try {
        const logStart = (await stat(requestLogPath)).size;
        const code =
          kind === "subagent"
            ? `const child = await sessions_spawn(${JSON.stringify({
                task: `Begin your synthetic report with ${marker}.`,
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
          responses: tool ? [{ events: toolEvents(runId, code) }] : [{ text: reply }],
          default: { text: reply },
        });
        if (options.canStart && !options.canStart()) {
          return null;
        }
        const retired = [];
        let sessionId = sessionPool.get(sessionKey);
        // Text conversations retain history; tool parents rotate generations so
        // their transcript growth stays separate from the persistent hot cohort.
        if (sessionId && !hot) {
          await retireSession(rpc, sessionKey, agentId, sessionId);
          sessionPool.delete(sessionKey);
          retired.push(sessionKey);
          sessionId = undefined;
        }
        if (!sessionId) {
          const session = await rpc("sessions.create", { key: sessionKey, agentId });
          if (session.ok !== true || session.key !== sessionKey || !session.sessionId) {
            throw new Error(`Synthetic session create failed: ${JSON.stringify(session)}`);
          }
          sessionId = session.sessionId;
          counts.created++;
          if (hot) {
            counts.hotSessions++;
          }
          if (kind !== "churn") {
            sessionPool.set(sessionKey, sessionId);
          }
        }
        if (options.canStart && !options.canStart()) {
          return null;
        }
        const started = await rpc(
          "chat.send",
          {
            sessionKey,
            agentId,
            message: `Synthetic heap rig ${kind} turn ${index}. Begin your report with ${marker}.`,
            deliver: false,
            idempotencyKey: runId,
            ...(kind === "artifact"
              ? {
                  attachments: [
                    {
                      type: "image",
                      mimeType: "image/png",
                      fileName: `${marker}.png`,
                      content: IMAGE_BASE64,
                    },
                  ],
                }
              : {}),
          },
          120_000,
        );
        if (started.runId !== runId || !["accepted", "started", "ok"].includes(started.status)) {
          throw new Error(`Synthetic turn was not accepted: ${JSON.stringify(started)}`);
        }
        const completed = await rpc("agent.wait", { runId, timeoutMs: 180_000 }, 190_000);
        const receipt = assertTerminal(completed, runId, reply, tool);
        await assertHistory(rpc, sessionKey, agentId, receipt.sessionId, reply);
        if (hot) {
          counts.hotTurns++;
        }
        let child;
        if (tool) {
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
            const childReceipt = assertTerminal(childCompleted, child.runId, reply, false);
            await assertHistory(rpc, child.childSessionKey, agentId, childReceipt.sessionId, reply);
            counts.children++;
            await retireSession(rpc, child.childSessionKey, agentId, childReceipt.sessionId);
            retired.push(child.childSessionKey);
          }
        }
        let artifactId;
        if (kind === "artifact") {
          const scope = { sessionKey, agentId };
          const listed = await rpc("artifacts.list", { ...scope, type: "image", limit: 4 });
          const artifact = listed.artifacts?.find((item) => item.title === `${marker}.png`);
          if (!artifact) {
            throw new Error(`Synthetic artifact missing: ${JSON.stringify(listed)}`);
          }
          artifactId = artifact.id;
          if (
            artifact.type !== "image" ||
            artifact.mimeType !== "image/png" ||
            artifact.source !== "session-transcript-preview" ||
            artifact.download?.mode !== "unsupported" ||
            !artifact.image?.url
          ) {
            throw new Error(`Synthetic artifact preview failed: ${JSON.stringify(artifact)}`);
          }
          counts.artifacts++;
        }
        let cron;
        if (kind === "churn") {
          // Manual runs keep the single scripted model owner deterministic while
          // exercising the real scheduler, isolated agent run, and history owner.
          const job = await rpc("cron.add", {
            name: `Synthetic heap rig ${index}`,
            agentId,
            enabled: false,
            schedule: { kind: "every", everyMs: 86_400_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: `Begin your synthetic report with ${marker}.` },
            delivery: { mode: "none" },
          });
          if (!job.id) {
            throw new Error(`Synthetic cron create failed: ${JSON.stringify(job)}`);
          }
          cron = await rpc(
            "cron.run",
            { id: job.id, mode: "force", waitTimeoutMs: 180_000 },
            190_000,
          );
          const summary = cron.run?.summary;
          if (
            cron.ok !== true ||
            cron.enqueued !== true ||
            cron.run?.status !== "ok" ||
            cron.run.error ||
            !cron.run.sessionId ||
            !cron.run.sessionKey ||
            cron.run.jobId !== job.id ||
            cron.run.runId !== cron.runId ||
            typeof summary !== "string" ||
            !summary.startsWith(`${marker}\n`) ||
            !reply.startsWith(summary.replace(/…$/u, ""))
          ) {
            throw new Error(`Synthetic cron did not complete: ${JSON.stringify(cron)}`);
          }
          const history = await rpc("cron.runs", { id: job.id, runId: cron.runId, limit: 1 });
          if (
            history.entries?.[0]?.status !== "ok" ||
            history.entries[0].runId !== cron.runId ||
            history.entries[0].sessionId !== cron.run.sessionId
          ) {
            throw new Error(`Synthetic cron history missing: ${JSON.stringify(history)}`);
          }
          // Completed cron runs retire their :run: alias. This owner resolves
          // the recorded physical transcript and applies its 8000-character cap.
          const transcript = await rpc("cron.history", {
            id: job.id,
            runId: cron.runId,
            limit: 20,
          });
          assertHistoryReply(
            transcript.messages,
            `${reply.slice(0, 8000)}\n...(truncated)...`,
            `cron ${job.id} (${cron.runId})`,
          );
          counts.cronRuns++;
          const removed = await rpc("cron.remove", { id: job.id });
          if (removed.removed !== true) {
            throw new Error(`Synthetic cron removal failed: ${JSON.stringify(removed)}`);
          }
          counts.cronJobsRemoved++;
          // Keep a bounded archived cohort alive long enough to distinguish
          // steady archive retention from intentionally growing row inventory.
          if (archivedSessions.length === 64) {
            const oldest = archivedSessions[0];
            await deleteSession(rpc, oldest.key, oldest.agentId, oldest.sessionId);
            archivedSessions.shift();
            retired.push(oldest.key);
          }
          await archiveSession(rpc, sessionKey, agentId, sessionId);
          archivedSessions.push({ key: sessionKey, agentId, sessionId });
          counts.archivedRetained = archivedSessions.length;
        }
        const result = {
          index,
          kind,
          runId,
          sessionKey,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          replyBytes: Buffer.byteLength(reply),
          successfulToolNames: receipt.successfulToolNames,
          sessionId,
          hot,
          retired,
          poolSize: sessionPool.size - counts.hotSessions,
          counts: { ...counts },
          ...(artifactId ? { artifactId } : {}),
          ...(kind === "churn" ? { archivedSessionKey: sessionKey } : {}),
          ...(cron ? { cronRunId: cron.runId, cronSessionKey: cron.run.sessionKey } : {}),
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
