import { createHash, randomInt } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { z } from "zod";
import { copyInternalToolResultState } from "../../packages/agent-core/src/internal-hooks.js";
import { WorkerGatewayToolResultSchema } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type {
  CodeModeJournal,
  CodeModeJournalCall,
} from "../config/sessions/code-mode-journal.types.js";
import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import {
  readCodeModeDurableRecovery,
  readCodeModeDurableSource,
} from "./code-mode-durable-context.js";
import type { CodeModeResultsAccess } from "./code-mode-results.js";
import {
  createCodeModeDurableJournalAccess,
  isCodeModeSessionStoreRequest,
  type CodeModeSessionStoreAccess,
} from "./code-mode-session-store.js";
import type {
  PendingBridgeRequest,
  SettledBridgeRequest,
  CodeModeWorkerBoundary,
} from "./code-mode-worker-types.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

const programSchema = z.object({
  version: z.literal(1),
  code: z.string(),
  assistantTurnId: z.string().optional(),
  catalogHash: z.string(),
  deterministic: z.object({ startedAt: z.number(), seed: z.number(), fingerprint: z.string() }),
});
const deliverySchema = z.object({
  reply: z.object({ id: z.string(), ok: z.boolean(), json: z.string() }),
  batch: z.number().int().nonnegative(),
  time: z.number(),
  networkContent: z.boolean(),
});
const outcomeSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    output: z.array(z.unknown()),
    error: z.string().optional(),
    value: z.unknown().optional(),
  })
  .catchall(z.unknown());

type ToolResult = Awaited<ReturnType<AnyAgentTool["execute"]>>;
const finalizers = new WeakMap<object, (result: ToolResult) => Promise<ToolResult>>();
const restoredResults = new WeakMap<object, ToolResult>();
export function readRestoredCodeModeResult(raw: object): ToolResult | undefined {
  return restoredResults.get(raw);
}
export async function finalizeCodeModeDurableResult(
  raw: object,
  result: ToolResult,
): Promise<ToolResult> {
  const finalize = finalizers.get(raw);
  if (!finalize) {
    return result;
  }
  const completed = await finalize(result);
  finalizers.delete(raw);
  return completed;
}

export type CodeModeDurable = NonNullable<ReturnType<typeof prepareCodeModeDurable>>;

/** A journal records host input delivery, not a VM heap or an authority grant. */
export function prepareCodeModeDurable(params: {
  ctx: ToolSearchToolContext;
  executionId: string;
  toolCallId: string;
  code: string;
  assistantTurnId?: string;
  catalog: unknown;
  projection: CodeModeCatalogProjection;
  runtime: ToolSearchRuntime;
  results: CodeModeResultsAccess;
  sessionStore?: CodeModeSessionStoreAccess;
}) {
  const store = createCodeModeDurableJournalAccess(params.ctx);
  const recovery = readCodeModeDurableRecovery();
  if (!store) {
    if (recovery) {
      throw new Error("Durable Code Mode recovery requires its original session store");
    }
    return undefined;
  }
  const catalogHash = createHash("sha256").update(JSON.stringify(params.catalog)).digest("hex");
  let journal: CodeModeJournal | undefined = recovery;
  const saved = recovery ? programSchema.parse(JSON.parse(recovery.programJson)) : undefined;
  if (saved && (saved.code !== params.code || saved.catalogHash !== catalogHash)) {
    throw new Error("Durable Code Mode program/catalog changed; no calls were replayed");
  }
  const deterministic = saved?.deterministic ?? {
    startedAt: Date.now(),
    seed: randomInt(0x1_0000_0000),
  };
  const seen = new Set<string>();
  const historical = recovery?.calls ?? [];
  const deliveries = historical
    .filter((call) => call.state === "completed")
    .toSorted((a, b) => a.deliveryIndex - b.deliveryIndex);
  let replayIndex = 0;
  let batch = 0;
  let time = deterministic.startedAt;
  const classify = (request: PendingBridgeRequest): "safe" | "interrupt" => {
    if (
      ["search", "describe", "skillsList", "skillsSearch", "skillsRead", "sleep"].includes(
        request.method,
      )
    ) {
      return "safe";
    }
    if (isCodeModeSessionStoreRequest(request)) {
      return "safe";
    }
    if (request.method === "callValue" && typeof request.args[0] === "string") {
      const binding = params.projection.byCallableName.get(request.args[0]);
      return binding && params.runtime.isReplaySafeExactId(binding.id) ? "safe" : "interrupt";
    }
    return "interrupt";
  };
  // An unresolved mutation may have taken effect. Do not execute any continuation behind it.
  const unsafe = historical.find((call) => call.state === "pending" && call.recovery !== "safe");
  return {
    deterministic,
    get restoredOutcome() {
      if (!recovery?.outcome) {
        return undefined;
      }
      const full: unknown = JSON.parse(recovery.outcome.resultJson);
      if (!Value.Check(WorkerGatewayToolResultSchema, full)) {
        throw new Error("Invalid durable Code Mode final tool result");
      }
      const raw = outcomeSchema.parse(full.details);
      restoredResults.set(raw, { ...full, details: raw });
      return raw;
    },
    async start(fingerprint: string | undefined) {
      if (!fingerprint) {
        throw new Error("Durable Code Mode engine did not provide a fingerprint");
      }
      if (saved && fingerprint !== saved.deterministic.fingerprint) {
        throw new Error("Durable Code Mode engine fingerprint changed");
      }
      if (unsafe) {
        throw new Error(
          "Durable Code Mode interrupted: call " +
            unsafe.key +
            " may have taken effect. Reconcile its original operation before retrying.",
        );
      }
      if (!journal) {
        journal = await store.begin({
          version: 1,
          executionId: params.executionId,
          runId: params.ctx.runId ?? params.executionId,
          toolCallId: params.toolCallId,
          source: {
            version: 1,
            sourceJson: JSON.stringify(readCodeModeDurableSource(params.ctx.catalogRef!)),
          },
          programJson: JSON.stringify({
            version: 1,
            code: params.code,
            assistantTurnId: params.assistantTurnId,
            catalogHash,
            deterministic: { ...deterministic, fingerprint },
          }),
        });
      }
    },
    async prepare(requests: PendingBridgeRequest[]) {
      if (!journal) {
        throw new Error("Durable Code Mode intent preceded the engine handshake");
      }
      for (const request of requests) {
        if (seen.has(request.id)) {
          continue;
        }
        const previous = historical[seen.size];
        const recoveryPolicy = classify(request);
        if (
          previous &&
          (previous.key !== request.id ||
            previous.name !== request.method ||
            previous.argsJson !== JSON.stringify(request.args) ||
            (previous.state === "pending" && recoveryPolicy !== "safe"))
        ) {
          throw new Error(
            "Durable Code Mode call path or replay policy changed; no new effects were dispatched",
          );
        }
        if (!previous) {
          journal = await store.call(journal.executionId, {
            key: request.id,
            operationId: journal.executionId + ":" + request.id,
            name: request.method,
            argsJson: JSON.stringify(request.args),
            recovery: recoveryPolicy,
          });
        }
        seen.add(request.id);
      }
    },
    async replay(boundary: CodeModeWorkerBoundary) {
      const first = deliveries[replayIndex];
      if (!first) {
        return undefined;
      }
      if (first.issuedCalls !== seen.size) {
        throw new Error("Durable Code Mode delivery frontier diverged");
      }
      const firstDelivery = deliverySchema.parse(JSON.parse(first.resultJson));
      const replies: SettledBridgeRequest[] = [];
      for (const call of deliveries.slice(replayIndex)) {
        const delivery = deliverySchema.parse(JSON.parse(call.resultJson));
        if (delivery.batch !== firstDelivery.batch) {
          break;
        }
        if (!boundary.pendingRequests.some((request) => request.id === call.key)) {
          throw new Error("Durable Code Mode delivered a result to a different call path");
        }
        if (delivery.networkContent) {
          params.runtime.observeNetworkContent(params.toolCallId);
        }
        await restoreLocal(
          call,
          delivery.reply,
          params.results,
          params.sessionStore,
          delivery.networkContent,
        );
        replies.push(delivery.reply);
        replayIndex++;
      }
      batch = firstDelivery.batch + 1;
      time = firstDelivery.time;
      const ids = new Set(replies.map((reply) => reply.id));
      return {
        replies,
        pending: boundary.pendingRequests.filter((request) => !ids.has(request.id)),
        time,
      };
    },
    async commitDelivery(replies: SettledBridgeRequest[]) {
      if (!journal || replies.length === 0) {
        return time;
      }
      // Record real elapsed time at each host boundary, then replay that exact
      // clock sample. Advancing one tick per reply breaks timer/deadline code.
      time = Math.max(time, Date.now());
      for (const reply of replies) {
        journal = await store.completeCall(journal.executionId, {
          key: reply.id,
          resultJson: JSON.stringify({
            reply,
            batch,
            time,
            networkContent: params.runtime.hasNetworkContent(),
          }),
          issuedCalls: journal.calls.length,
        });
      }
      batch++;
      return time;
    },
    async finish(result: { status: string; output: unknown[] }) {
      if (!journal || result.status === "waiting") {
        return;
      }
      if (
        result.status === "completed" &&
        (seen.size < historical.length || replayIndex < deliveries.length)
      ) {
        throw new Error("Durable Code Mode terminated before replaying its committed history");
      }
      const id = journal.executionId;
      const prepared =
        result.status === "completed"
          ? await params.sessionStore?.prepareDurableCommit()
          : undefined;
      finalizers.set(result, async (full) => {
        const completed = {
          ...full,
          details: {
            ...(isRecord(full.details) ? full.details : {}),
            durableExecutionId: id,
            ...(prepared ? { codeModeStore: prepared.data } : {}),
          },
        };
        await store.finish(id, {
          resultJson: JSON.stringify(completed),
          storeJson: JSON.stringify(prepared?.data ?? {}),
        });
        prepared?.publish();
        return copyInternalToolResultState(full, completed);
      });
    },
  };
}

async function restoreLocal(
  call: CodeModeJournalCall,
  reply: SettledBridgeRequest,
  results: CodeModeResultsAccess,
  sessionStore: CodeModeSessionStoreAccess | undefined,
  networkContent: boolean,
) {
  if (!reply.ok) {
    return;
  }
  const args: unknown[] = JSON.parse(call.argsJson);
  if (call.name === "resultSave") {
    if (args[1] === "session") {
      await sessionStore?.save(args[2], args[0], networkContent);
    } else {
      results.restore(args[0], JSON.parse(reply.json), networkContent);
    }
  } else if (call.name === "resultDelete") {
    if (args[1] === "session") {
      await sessionStore?.delete(args[0]);
    } else {
      results.delete(args[0]);
    }
  }
}
