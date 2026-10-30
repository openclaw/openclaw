import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openPrivatePartition } from "./memory-index-hook.js";
import {
  decide,
  GATE_BODY_MAX,
  renderInjection,
  type GateDecision,
  type RecallGatePolicy,
} from "./recall-gate.js";
import type { Stores } from "./stores.js";

// Lines read for a high-tier page; renderInjection clips the body to GATE_BODY_MAX.
const BODY_LINES = 60;

type GateRecord = {
  mode: RecallGatePolicy["mode"];
  outcome: "injected" | "shadow" | "none" | "error";
  ms: number;
  offered?: number;
  decisions?: GateDecision[];
  injectedChars?: number;
  error?: string;
};

/** Per user turn, asks the configured decision model which Knowledge index
 * entries the message needs and, in live mode, prepends the matches to that
 * turn's user message. The index goes only to the decision model. Shadow mode
 * logs the decisions and injects nothing. Timeouts and errors inject nothing
 * and never fail the turn. Logs carry record IDs and scores, never message or
 * record text. */
export function registerRecallGateHook(
  api: OpenClawPluginApi,
  stores: Stores,
  policy: RecallGatePolicy,
  fetchImpl?: typeof fetch,
): void {
  const log = (record: GateRecord) =>
    api.logger?.info?.(`knowledge recall gate: ${JSON.stringify(record)}`);
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      // Only user turns; heartbeat, cron and other automated runs skip the gate.
      if (ctx.trigger !== "user") {
        return undefined;
      }
      const started = performance.now();
      const ms = () => Math.round(performance.now() - started);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`timed out after ${policy.timeoutMs}ms`)),
        policy.timeoutMs,
      );
      const deadline = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = controller.signal.reason;
            reject(reason instanceof Error ? reason : new Error("recall gate aborted"));
          },
          { once: true },
        );
      });
      const run = (async () => {
        const opened = await openPrivatePartition(stores, ctx);
        if (!opened) {
          return undefined;
        }
        const { runtime, access } = opened;
        const { entries } = await runtime.enqueue(access.assertCurrent, () =>
          runtime.client.call("gateIndex", access),
        );
        const message = event.currentUserMessage ?? event.prompt;
        const decisions = await decide({
          policy,
          entries,
          message,
          signal: controller.signal,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        const base = { mode: policy.mode, offered: entries.length, decisions };
        const hits = decisions.filter((d) => d.tier !== "low");
        if (policy.mode === "shadow" || hits.length === 0) {
          log({ ...base, outcome: hits.length ? "shadow" : "none", ms: ms() });
          return undefined;
        }
        const byId = new Map(entries.map((e) => [e.id, e]));
        const items = await Promise.all(
          hits.map(async (d) => {
            const entry = byId.get(d.id)!;
            if (d.tier !== "high") {
              return { entry, tier: d.tier };
            }
            const found = await runtime.enqueue(access.assertCurrent, () =>
              runtime.client.call("memoryGet", access, { id: d.id, from: 1, count: BODY_LINES }),
            );
            return found.status === "ok"
              ? { entry, tier: d.tier, body: found.text.slice(0, GATE_BODY_MAX + 1) }
              : { entry, tier: d.tier };
          }),
        );
        const text = renderInjection(items);
        // Publication is the boundary: a turn whose deadline, hook lifetime or
        // memory audience lapsed while the gate ran gets nothing.
        controller.signal.throwIfAborted();
        access.assertCurrent();
        log({ ...base, outcome: text ? "injected" : "none", injectedChars: text.length, ms: ms() });
        return text ? { prependContext: text } : undefined;
      })();
      // The losing branch of the race still settles; never leave it unobserved.
      run.catch(() => undefined);
      try {
        return await Promise.race([run, deadline]);
      } catch (error) {
        log({
          mode: policy.mode,
          outcome: "error",
          ms: ms(),
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    // The host timeout is a backstop behind the gate's own budget.
    { timeoutMs: policy.timeoutMs + 1_000 },
  );
}
