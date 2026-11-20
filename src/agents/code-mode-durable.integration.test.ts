import assert from "node:assert/strict";
import { afterEach, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withCodeModeDurableRecovery } from "./code-mode-durable-context.js";
import {
  bindCodeModeSessionStore,
  createCodeModeDurableJournalAccess,
} from "./code-mode-session-store.js";
import {
  createCatalogCodeModeHarness,
  jsonTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { withSessionState } from "./sessions/session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "./sessions/session-manager-reader.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

it.each(["safe", "batch", "unsafe", "catalog"])(
  "recovers a fresh QuickJS VM with %s call history",
  (scenario) =>
    withSessionState("durable-real-engine", ({ scope }) =>
      withSelectedTranscriptReader(
        scope,
        async () => {
          let bCalls = 0;
          const a = jsonTool("durable_a", { exact: "first receipt" });
          const b = pluginToolWithExecute(
            "durable_b",
            "Safe pending read",
            async (_id, _input, signal) => {
              bCalls++;
              if (bCalls === 1) {
                await new Promise<void>((resolve) =>
                  signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
              }
              return jsonResult({ recovered: true });
            },
          );
          setPluginToolMeta(b, {
            pluginId: "durable-test",
            optional: true,
            replaySafe: scenario !== "unsafe",
            sideEffecting: false,
          });
          const c = jsonTool("durable_c", true);
          const bind = async (timeoutMs: number, changed = false) => {
            const h = createCatalogCodeModeHarness(
              changed ? [a, b, c, jsonTool("added_tool", true)] : [a, b, c],
              { codeMode: { executor: "quickjs", timeoutMs } },
            );
            Object.assign(h.ctx, {
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
              agentId: scope.agentId,
            });
            bindCodeModeSessionStore(h.catalogRef, await SessionManager.openAsync(scope));
            return h;
          };
          const original = await bind(3_000);
          const calls =
            scenario === "batch"
              ? "const ap = durable_a({}); const bp = durable_b({}); const a = await ap; const b = await bp;"
              : "const a = await durable_a({}); const b = await durable_b({});";
          const code = `const random = Math.random(); const ref = await results.save({exact: [1, 2]}); await store("checkpoint", {saved: true}); const beforeSleep = Date.now(); await new Promise(resolve => setTimeout(resolve, 30)); const elapsed = Date.now() - beforeSleep; ${calls} await durable_c({}); return {random, elapsed, a, b, saved: await results.load(ref.id), checkpoint: await load("checkpoint")};`;
          const parked = await original.run(code, "original-outer");
          expect(parked, JSON.stringify(parked)).toMatchObject({ status: "waiting" });
          const access = createCodeModeDurableJournalAccess(original.ctx)!;
          const journals = await access.list();
          assert(journals.length === 1);
          const journal = await access.read(journals[0]!.executionId);
          assert(journal);
          expect(journal.calls.filter((call) => call.state === "pending")).toHaveLength(1);
          expect(journal.calls.filter((call) => call.state === "completed")).toHaveLength(4);
          await resetCodeModeTestState();
          const fresh = await bind(10_000, scenario === "catalog");
          const completed = await withCodeModeDurableRecovery(journal, () =>
            fresh.run(code, "original-outer", { awaitResults: true }),
          );
          if (scenario === "unsafe" || scenario === "catalog") {
            expect(completed).toMatchObject({
              status: "failed",
              error: expect.stringContaining(
                scenario === "unsafe" ? "may have taken effect" : "catalog changed",
              ),
            });
            expect(a.execute).toHaveBeenCalledTimes(1);
            expect(bCalls).toBe(1);
            expect(c.execute).not.toHaveBeenCalled();
            return;
          }
          expect(completed, JSON.stringify(completed)).toMatchObject({
            status: "completed",
            value: {
              a: { exact: "first receipt" },
              b: { recovered: true },
              saved: { exact: [1, 2] },
              checkpoint: { saved: true },
            },
          });
          const value = completed.value;
          assert(value && typeof value === "object" && "elapsed" in value);
          expect(value.elapsed).toBeGreaterThanOrEqual(20);
          expect(a.execute).toHaveBeenCalledTimes(1);
          expect(bCalls).toBe(2);
          expect(c.execute).toHaveBeenCalledTimes(1);
          const finished = await createCodeModeDurableJournalAccess(fresh.ctx)!.read(
            journal.executionId,
          );
          assert(finished?.outcome);
          if (scenario === "safe") {
            const exactResult = JSON.parse(finished.outcome.resultJson);
            await resetCodeModeTestState();
            const terminalRecovery = await bind(10_000);
            const restored = await withCodeModeDurableRecovery(finished, () =>
              terminalRecovery.execute(code, "original-outer", { awaitResults: true }),
            );
            expect(restored).toEqual(exactResult);
            expect(bCalls).toBe(2);
            const manager = await SessionManager.openAsync(scope);
            await manager.appendMessageAsync({
              role: "toolResult",
              toolName: "exec",
              toolCallId: "original-outer",
              ...exactResult,
              timestamp: Date.now(),
              isError: false,
            });
            expect(
              await createCodeModeDurableJournalAccess(terminalRecovery.ctx)!.list(),
            ).toHaveLength(0);
            const next = await bind(10_000);
            expect(await next.run(`return await load("checkpoint");`, "next-cell")).toMatchObject({
              status: "completed",
              value: { saved: true },
            });
          }
        },
        true,
      ),
    ),
  30_000,
);
