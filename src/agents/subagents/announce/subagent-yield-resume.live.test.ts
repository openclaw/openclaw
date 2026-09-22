import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type {
  TaskSummary,
  TasksCancelResult,
} from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { runCommandWithTimeout } from "../../../process/exec.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import { onSubagentRegistryPersisted } from "../registry/subagent-registry-state.js";
import {
  countPendingDescendantRuns,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry.test-helpers.js";
import {
  boundedCount,
  commandOutcomes,
  finalReplies,
  gateTask,
  history,
  runWithLiveSubagentGateway,
  statusReport,
  successfulYields,
  until,
} from "./subagent-challenges.live.test-support.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_STRESS);
const describeLive = enabled ? describe : describe.skip;

describeLive("OpenAI subagent yield and operator resume stress", () => {
  it.each([false, true])(
    "keeps CLI coordination in the task completion path for visible=%s children and later turns",
    async (visible) => {
      await runWithLiveSubagentGateway(
        {},
        async ({ gateway, state, start, record, sessionsSendCliArgs, waitForFinal }) => {
          const id = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:live-cli-parent:${id}`;
          const targetKey = `agent:main:dashboard:live-cli-target-${id}`;
          const parentMarker = `PARENT_${id}`;
          const childMarker = `CHILD_${id}`;
          const followupMarker = `FOLLOWUP_${id}`;
          await gateway.request("sessions.create", { key: targetKey, agentId: "main" });
          const untouchedTarget = await history(targetKey);
          const repoDir = process.cwd();

          const probeTask = async (round: string, finalMarker: string) => {
            const probeFile = path.join(state.workspaceDir, `cli-probe-${round}.mjs`);
            const resultFile = path.join(state.workspaceDir, `cli-probe-${round}.json`);
            const argv = sessionsSendCliArgs({
              key: targetKey,
              message: `Reply exactly UNEXPECTED_${round}_${id}.`,
              idempotencyKey: randomUUID(),
            });
            const source = [
              'import { spawnSync } from "node:child_process";',
              'import { writeFileSync } from "node:fs";',
              `const result = spawnSync(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))}, { cwd: ${JSON.stringify(repoDir)}, env: { ...process.env, OPENCLAW_TEST_RUNTIME_LOG: "1" }, encoding: "utf8", timeout: 240000 });`,
              `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, marker: process.env.OPENCLAW_SUBAGENT_EXEC ?? null }));`,
              'process.stdout.write(result.stdout ?? "");',
              'process.stderr.write(result.stderr ?? "");',
              "process.exitCode = result.status ?? 1;",
            ].join("\n");
            await fs.writeFile(probeFile, source);
            const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
            return {
              probeFile,
              resultFile,
              source,
              task: [
                "Run this intentional routing regression probe exactly once with exec, allowing 300 seconds:",
                `${quote(process.execPath)} ${quote(probeFile)}`,
                "If it backgrounds, use process to await its result. Do not edit or read the script, change its environment, retry it, or contact the target any other way.",
                "The expected command outcome is a rejection directing subagents to the task completion path. Treat that rejection as the successful outcome of this probe.",
                `After observing the command, return your ordinary final reply exactly ${finalMarker}. Do not use messaging or session tools to report it.`,
              ].join("\n"),
            };
          };
          const verifyProbe = async (
            childKey: string,
            probe: Awaited<ReturnType<typeof probeTask>>,
            attempts: number,
          ) => {
            const result = asOptionalRecord(
              JSON.parse(await fs.readFile(probe.resultFile, "utf8")),
            );
            record("child-cli-observed", { visible, childKey, result });
            expect(result).toMatchObject({ marker: "1", status: 1, signal: null });
            const output = [result?.stdout, result?.stderr]
              .filter((value): value is string => typeof value === "string")
              .join("\n");
            expect(output).toContain("task completion path");
            expect(await fs.readFile(probe.probeFile, "utf8")).toBe(probe.source);
            expect(
              commandOutcomes(await history(childKey)).filter(
                (outcome) =>
                  outcome.exitCode !== 0 && outcome.text.includes("task completion path"),
              ),
              "each child turn observed one actual CLI rejection",
            ).toHaveLength(attempts);
            expect(
              await history(targetKey),
              "the CLI attempt left the idle target untouched",
            ).toEqual(untouchedTarget);
            record("child-cli-rejected", { visible, childKey, result });
          };

          const firstProbe = await probeTask("first", childMarker);
          await start(
            parentKey,
            [
              `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "cli_completion_probe", task: firstProbe.task, cleanup: "keep", context: "isolated", ...(visible ? { visible: true } : {}) })}.`,
              "The visible setting is intentional for this test. After acceptance call sessions_yield. Do not inspect child files or execute the probe yourself.",
              `When the actual child completion arrives, reply exactly ${parentMarker} on the first line and ${childMarker} on the second.`,
            ].join("\n"),
          );
          await waitForFinal(parentKey, parentMarker, `${parentMarker}\n${childMarker}`);
          const children = listSubagentRunsForRequester(parentKey);
          expect(children).toHaveLength(1);
          const child = children[0]!;
          expect(child.execution.outcome?.status).toBe("ok");
          expect(child.delivery?.status).toBe("delivered");
          expect(finalReplies(await history(child.childSessionKey), childMarker)).toEqual([
            childMarker,
          ]);
          await verifyProbe(child.childSessionKey, firstProbe, 1);

          const nextProbe = await probeTask("followup", followupMarker);
          const followup = await gateway.request<{ runId: string }>("sessions.send", {
            key: child.childSessionKey,
            message: nextProbe.task,
            idempotencyKey: randomUUID(),
          });
          const finished = await until("later child turn settles", async () => {
            const outcome = await gateway.request<{ status: string }>("agent.wait", {
              runId: followup.runId,
              timeoutMs: 1000,
            });
            return outcome.status === "ok" || outcome.status === "error" ? outcome : undefined;
          });
          expect(finished.status).toBe("ok");
          expect(finalReplies(await history(child.childSessionKey), followupMarker)).toEqual([
            followupMarker,
          ]);
          await verifyProbe(child.childSessionKey, nextProbe, 2);
          expect(
            finalReplies(await history(parentKey), ""),
            "no follow-up receipt or unlabelled child report reached the parent",
          ).toEqual([`${parentMarker}\n${childMarker}`]);

          const operatorMarker = `OPERATOR_${id}`;
          const operator = await runCommandWithTimeout(
            sessionsSendCliArgs({
              key: targetKey,
              message: `Do not call tools. Reply exactly ${operatorMarker}.`,
              idempotencyKey: randomUUID(),
            }),
            {
              cwd: repoDir,
              env: { ...state.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
              timeoutMs: 300000,
              maxOutputBytes: 64000,
            },
          );
          record("operator-cli-observed", {
            visible,
            targetKey,
            exitCode: operator.code,
            stdout: operator.stdout,
            stderr: operator.stderr,
          });
          expect(operator.code, operator.stderr).toBe(0);
          const operatorReply = await until(
            "operator CLI reply",
            async () => finalReplies(await history(targetKey), operatorMarker)[0],
          );
          expect(operatorReply).toBe(operatorMarker);
          expect(finalReplies(await history(targetKey), operatorMarker)).toEqual([operatorMarker]);
          record("operator-cli-accepted", {
            visible,
            targetKey,
            exitCode: operator.code,
            reply: operatorReply,
          });
        },
      );
    },
    20 * 60_000,
  );

  it(
    "settles concurrent children and preserves a resumed worker's task and parent batch",
    async () => {
      const batches = boundedCount("OPENCLAW_LIVE_SUBAGENT_STRESS_BATCHES", 2, 5);
      const childrenPerBatch = boundedCount("OPENCLAW_LIVE_SUBAGENT_STRESS_CHILDREN", 3, 6);
      await runWithLiveSubagentGateway(
        { children: childrenPerBatch },
        async ({ gateway, state, gates, start, record, interrogate, waitForFinal }) => {
          let parentYields = 0;
          for (let batch = 0; batch < batches; batch += 1) {
            const batchId = randomUUID().replaceAll("-", "");
            const parentKey = `agent:main:live-yield-stress:${batchId}`;
            const parentMarker = `PARENT_${batchId}`;
            const childResults: string[] = [];
            const spawns: Record<string, unknown>[] = [];
            for (let child = 0; child < childrenPerBatch; child += 1) {
              const result = `CHILD_${randomUUID()}`;
              childResults.push(result);
              const chain = Array.from({ length: 4 }, () => `${randomUUID()}.txt`);
              for (let index = 0; index < chain.length; index += 1) {
                await fs.writeFile(
                  path.join(state.workspaceDir, chain[index]!),
                  `${chain[index + 1] ?? result}\n`,
                );
              }
              spawns.push({
                taskName: `stress_${batch}_${child}`,
                cleanup: "keep",
                context: "isolated",
                task: `Use only read. Read ${chain[0]}. The contents name the next workspace file. Follow one filename at a time until the contents start CHILD_. Reply with that exact result only. Do not use exec or spawn.`,
              });
            }
            console.log(
              `[subagent-handoff-stress] ${JSON.stringify({ phase: "fanout", batch: batch + 1, children: childrenPerBatch })}`,
            );
            await start(
              parentKey,
              [
                "Use tools for this exact bounded task. Do not inspect workspace files yourself.",
                "Spawn all children below before waiting; issue their sessions_spawn calls together if possible. Do not spawn any additional children.",
                ...spawns.map((spawn) => `sessions_spawn input: ${JSON.stringify(spawn)}`),
                "After every spawn is accepted, call sessions_yield immediately. Wait for all actual child completion results.",
                `Your only final reply must be ${parentMarker} on the first line, then the exact child result for each child in spawn order, one result per line. No commentary or other content.`,
              ].join("\n"),
            );
            parentYields += await waitForFinal(
              parentKey,
              parentMarker,
              [parentMarker, ...childResults].join("\n"),
            );
            const children = listSubagentRunsForRequester(parentKey);
            expect(children.length, "exact child fanout").toBe(childrenPerBatch);
            expect(
              children.every(
                (run) =>
                  run.execution.outcome?.status === "ok" && run.delivery?.status === "delivered",
              ),
              "all child tasks succeeded and delivered",
            ).toBe(true);
            const firstEnd = Math.min(...children.map((run) => run.execution.endedAt!));
            expect(
              children.every((run) => run.createdAt <= firstEnd),
              "all children spawned before any finished",
            ).toBe(true);
          }

          const resumeId = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:live-resume-stress:${resumeId}`;
          const parentMarker = `RESUME_PARENT_${resumeId}`;
          const operatorResult = `OPERATOR_RESULT_${randomUUID()}`;
          const resumeGate = gates.create();
          const leafTask = gateTask(resumeGate.url);
          const workerTask = `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "resume_gate_leaf", task: leafTask, cleanup: "keep", context: "isolated" })}. Immediately after acceptance call sessions_yield. On the child's completion reply with its exact result only.`;
          await start(
            parentKey,
            [
              `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "resume_worker", task: workerTask, cleanup: "keep", context: "isolated" })}.`,
              "After acceptance call sessions_yield and wait for this worker's actual completion. Do not inspect files or call other tools.",
              `Your only final reply must be ${parentMarker} on one line and the worker's exact result on the next line.`,
            ].join("\n"),
          );
          await until("external request held by gate", () =>
            resumeGate.snapshot().waiting === 1 ? true : undefined,
          );
          const paused = await until("worker and parent yielded", () =>
            listSubagentRunsForRequester(parentKey).find(
              (run) =>
                run.taskName === "resume_worker" &&
                run.pauseReason === "sessions_yield" &&
                run.requesterSettleWake?.requesterYieldBatch === true,
            ),
          );
          const waitingReport = await interrogate(parentKey, `STATUS_${resumeId}`);
          expect(waitingReport.workComplete, "closed external gate means unfinished work").toBe(
            false,
          );
          const waitingWorker = waitingReport.workers.find(
            (worker) => worker.taskName === "resume_worker",
          );
          expect(waitingWorker?.state, "orchestrator is waiting for its leaf").toBe("waiting");
          expect(waitingWorker?.waitingFor, "report identifies the actual dependency").toContain(
            "resume_gate_leaf",
          );
          expect(waitingWorker?.result, "waiting worker has no final result").toBeNull();
          expect(
            waitingReport.workers.some(
              (worker) =>
                worker.taskName === "resume_gate_leaf" &&
                ["running", "waiting"].includes(worker.state),
            ),
            "report includes the held external worker",
          ).toBe(true);
          expect(
            resumeGate.snapshot(),
            "status interrogation leaves gate and request untouched",
          ).toEqual({ requests: 1, waiting: 1, released: false });
          expect(
            finalReplies(await history(parentKey), parentMarker),
            "status is not task completion",
          ).toEqual([]);
          expect(
            listSubagentRunsForRequester(parentKey).map((run) => run.runId),
            "status creates no successor worker",
          ).toEqual([paused.runId]);
          record("external-wait", {
            sessionKey: parentKey,
            gate: resumeGate.snapshot(),
            pending: countPendingDescendantRuns(parentKey),
          });
          const tasks = await gateway.request<{ tasks: TaskSummary[] }>("tasks.list", {
            sessionKey: parentKey,
            limit: 100,
          });
          const originalTask = tasks.tasks.find(
            (task) =>
              task.childSessionKey === paused.childSessionKey && task.runtime === "subagent",
          );
          expect(Boolean(originalTask), "original canonical task exists").toBe(true);
          const resumeKey = randomUUID();
          const followup = {
            key: paused.childSessionKey,
            idempotencyKey: resumeKey,
            message: `The operator is resuming this same task with a new requested result. Do not create tasks, inspect files, wait, or call tools. Finish now by replying exactly ${operatorResult}.`,
          };
          const accepted = await gateway.request<{ runId: string }>("sessions.send", followup);
          const resumed = await until("operator resume adopted original worker", () =>
            listSubagentRunsForRequester(parentKey).find((run) => run.runId === accepted.runId),
          );
          expect(
            resumed.taskRunId === (paused.taskRunId ?? paused.runId),
            "same canonical task run",
          ).toBe(true);
          expect(resumed.requesterSessionKey === parentKey, "same parent recipient").toBe(true);
          expect(
            resumed.requesterSettleWake?.batchRunIds?.includes(accepted.runId),
            "parent batch follows the successor",
          ).toBe(true);
          expect(
            resumed.requesterSettleWake?.batchRunIds?.includes(paused.runId),
            "parent batch retires predecessor",
          ).toBe(false);
          const replayed = await gateway.request<{ runId: string }>("sessions.send", followup);
          expect(replayed.runId === accepted.runId, "operator retry reuses its accepted run").toBe(
            true,
          );
          resumeGate.release(`GATE_RESULT_${randomUUID()}`);
          parentYields += await waitForFinal(
            parentKey,
            parentMarker,
            `${parentMarker}\n${operatorResult}`,
          );
          expect(
            finalReplies(await history(paused.childSessionKey), operatorResult).length,
            "operator replay did not execute a second worker turn",
          ).toBe(1);
          const finalTask = await gateway.request<{ task: TaskSummary }>("tasks.get", {
            taskId: originalTask!.id,
          });
          expect(finalTask.task.id === originalTask!.id, "canonical task id survives resume").toBe(
            true,
          );
          expect(
            finalTask.task.status === "completed" && finalTask.task.deliveryStatus === "delivered",
            "resumed canonical task completed and delivered",
          ).toBe(true);
          expect(listSubagentRunsForRequester(parentKey).length, "no duplicate worker task").toBe(
            1,
          );
          console.log(
            `[subagent-handoff-stress] ${JSON.stringify({ phase: "passed", batches, childrenPerBatch, successfulFanoutChildren: batches * childrenPerBatch, parentYields, automaticParentFinals: batches + 1, operatorResumes: 1, operatorReplays: 1, sameTask: true, remappedBatch: true })}`,
          );
        },
      );
    },
    30 * 60_000,
  );

  it.each(["timeout", "cancellation", "service_failure"] as const)(
    "reports a child's %s truthfully while preserving its successful sibling",
    async (interruption) => {
      await runWithLiveSubagentGateway(
        {},
        async ({ gateway, gates, start, record, interrogate }) => {
          const id = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:live-${interruption}:${id}`;
          const marker = `OUTCOME_${id}`;
          const goodGate = gates.create();
          const interruptedGate = gates.create();
          const goodResult = `RESULT_${randomUUID()}`;
          const lateResult = `LATE_${randomUUID()}`;
          const serviceError = `UPSTREAM_UNAVAILABLE_${randomUUID()}`;
          const spawns = [
            { taskName: "result_worker", task: gateTask(goodGate.url) },
            {
              taskName: "interrupted_worker",
              task: gateTask(interruptedGate.url),
              ...(interruption === "timeout" ? { runTimeoutSeconds: 90 } : {}),
            },
          ];
          await start(
            parentKey,
            [
              "Delegate the following two independent retrieval jobs. Start both before waiting. Do not read files, run commands, fetch results yourself, or create replacement workers.",
              ...spawns.map(
                (spawn) =>
                  `sessions_spawn input: ${JSON.stringify({ ...spawn, cleanup: "keep", context: "isolated" })}`,
              ),
              "Call sessions_yield after both are accepted. Continue handling the existing jobs until both have settled, including any failure or cancellation.",
              "Use state values queued, running, waiting, completed, failed, timed_out, cancelled, or unknown. Your final report must distinguish successful retrieval from any unsuccessful worker. workComplete means both requested results were successfully obtained. Never report a result you did not receive.",
              "Copy received result values and error evidence verbatim, preserving every character of their identifiers in the JSON report.",
              `Reply with ${marker} on the first line, then a JSON object with workComplete (boolean) and workers (array of {taskName, state, waitingFor, result, error}). result is the successfully retrieved value; error is the worker's failure evidence. Use null when absent or unknown.`,
            ].join("\n"),
          );
          await until("both independent requests are held", () =>
            goodGate.snapshot().waiting === 1 && interruptedGate.snapshot().waiting === 1
              ? true
              : undefined,
          );
          const children = listSubagentRunsForRequester(parentKey);
          expect(
            children
              .map((run) => run.taskName ?? "")
              .toSorted((left, right) => left.localeCompare(right)),
          ).toEqual(["interrupted_worker", "result_worker"]);
          expect(children.every((run) => run.execution.status === "running")).toBe(true);
          expect(
            finalReplies(await history(parentKey), marker),
            "parent cannot complete before either gate opens",
          ).toEqual([]);
          record("both-waiting", {
            interruption,
            gates: [goodGate.snapshot(), interruptedGate.snapshot()],
          });

          goodGate.release(goodResult);
          const goodRun = await until("successful sibling execution settled", () =>
            listSubagentRunsForRequester(parentKey).find(
              (run) => run.taskName === "result_worker" && run.execution.status === "terminal",
            ),
          );
          record("successful-sibling-terminal", {
            runId: goodRun.runId,
            outcome: goodRun.execution.outcome,
          });
          expect(goodRun.execution.outcome?.status, "the retrieval sibling succeeded").toBe("ok");
          const page = await gateway.request<{ tasks: TaskSummary[] }>("tasks.list", {
            sessionKey: parentKey,
            limit: 100,
          });
          const goodChild = children.find((run) => run.taskName === "result_worker")!;
          const interruptedChild = children.find((run) => run.taskName === "interrupted_worker")!;
          const goodTask = page.tasks.find(
            (task) => task.childSessionKey === goodChild.childSessionKey,
          )!;
          const interruptedTask = page.tasks.find(
            (task) => task.childSessionKey === interruptedChild.childSessionKey,
          )!;
          expect(goodTask.status, "child execution can finish while its parent is unfinished").toBe(
            "completed",
          );
          expect(interruptedGate.snapshot().released).toBe(false);
          expect(
            finalReplies(await history(parentKey), marker),
            "one child's execution success is not parent completion",
          ).toEqual([]);
          record("partial-completion", {
            goodTask,
            interruptedTask,
            gate: interruptedGate.snapshot(),
          });

          if (interruption === "cancellation") {
            let claimObserved:
              | { runId: string; requestedAt: number; pendingRequests: number }
              | undefined;
            // The production persistence event observes the claim before admission draining.
            const unsubscribe = onSubagentRegistryPersisted(() => {
              if (claimObserved) {
                return;
              }
              const current = listSubagentRunsForRequester(parentKey).find(
                (run) => run.runId === interruptedChild.runId,
              );
              if (!current?.killIntent) {
                return;
              }
              const observation = {
                runId: current.runId,
                requestedAt: current.killIntent.requestedAt,
                pendingRequests: interruptedGate.snapshot().waiting,
              };
              interruptedGate.release(lateResult);
              claimObserved = observation;
            });
            try {
              const result = await gateway.request<TasksCancelResult>("tasks.cancel", {
                taskId: interruptedTask.id,
                reason: "operator cancelled retrieval",
              });
              record("cancel-response", {
                taskId: interruptedTask.id,
                claimObserved,
                result,
                gate: interruptedGate.snapshot(),
              });
              expect(result, "the active child accepts operator cancellation").toMatchObject({
                found: true,
                cancelled: true,
              });
              expect(
                claimObserved,
                "the real cancellation owner claims the run before late stdout is released",
              ).toMatchObject({ runId: interruptedChild.runId, pendingRequests: 1 });
            } finally {
              unsubscribe();
            }
          } else if (interruption === "service_failure") {
            interruptedGate.release(serviceError, 503);
            record("service-error-released", { responseCode: 503, serviceError });
          }
          const expectedTaskStatus =
            interruption === "timeout"
              ? "timed_out"
              : interruption === "cancellation"
                ? "cancelled"
                : "completed";
          const terminalTask = await until("interrupted child task settles", async () => {
            const { task } = await gateway.request<{ task: TaskSummary }>("tasks.get", {
              taskId: interruptedTask.id,
            });
            return task.status === expectedTaskStatus ? task : undefined;
          });
          if (interruption === "service_failure") {
            const failures = commandOutcomes(await history(interruptedChild.childSessionKey));
            expect(
              failures.some(
                (outcome) => outcome.exitCode === 1 && outcome.text.includes(serviceError),
              ),
              "the child actually observes the service error through a failed command",
            ).toBe(true);
            const child = listSubagentRunsForRequester(parentKey).find(
              (run) => run.runId === interruptedChild.runId,
            );
            expect(
              child?.execution.outcome?.status,
              "the agent turn completed normally even though retrieval failed",
            ).toBe("ok");
            record("service-failure-observed", { task: terminalTask, commands: failures });
          }
          const reply = await until(
            "automatic parent outcome after mixed child outcomes",
            async () => finalReplies(await history(parentKey), marker)[0],
          );
          record("primary-parent-reply", { sessionKey: parentKey, reply });
          try {
            const report = statusReport(reply);
            expect(report.workComplete, "a missing child result prevents overall success").toBe(
              false,
            );
            expect(report.workers).toHaveLength(2);
            const success = report.workers.find((worker) => worker.taskName === "result_worker");
            const failure = report.workers.find(
              (worker) => worker.taskName === "interrupted_worker",
            );
            expect(success).toMatchObject({
              state: "completed",
              waitingFor: null,
              result: goodResult,
            });
            expect(
              interruption === "timeout"
                ? ["failed", "timed_out"]
                : interruption === "cancellation"
                  ? ["cancelled"]
                  : ["failed"],
            ).toContain(failure?.state);
            expect(
              failure?.result,
              "failed or cancelled worker has no successful retrieval",
            ).toBeNull();
            if (interruption === "service_failure") {
              expect(
                failure?.error,
                "the parent carries the actual hidden service failure",
              ).toContain(serviceError);
            }
            expect(reply, "late cancelled stdout is not a delivered result").not.toContain(
              lateResult,
            );
            await until("all child obligations settled", () =>
              countPendingDescendantRuns(parentKey) === 0 ? true : undefined,
            );
            const finalMessages = await history(parentKey);
            expect(finalReplies(finalMessages, marker)).toHaveLength(1);
            expect(successfulYields(finalMessages)).toBeGreaterThan(0);
            expect(
              finalMessages.some(
                (message) =>
                  message.role === "toolResult" &&
                  ["read", "exec", "process"].includes(String(message.toolName)),
              ),
              "parent consumes child delivery rather than obtaining hidden data",
            ).toBe(false);
            const finalGoodTask = await gateway.request<{ task: TaskSummary }>("tasks.get", {
              taskId: goodTask.id,
            });
            expect(finalGoodTask.task).toMatchObject({
              id: goodTask.id,
              status: "completed",
              deliveryStatus: "delivered",
            });
            expect(listSubagentRunsForRequester(parentKey)).toHaveLength(2);
            if (interruption === "service_failure") {
              const deliveredFailure = await gateway.request<{ task: TaskSummary }>("tasks.get", {
                taskId: interruptedTask.id,
              });
              expect(deliveredFailure.task).toMatchObject({
                status: "completed",
                deliveryStatus: "delivered",
              });
            }
            record("mixed-outcome", {
              interruption,
              report,
              terminalTask,
              successfulTask: finalGoodTask.task,
            });
          } catch (error) {
            // A diagnostic follow-up never turns a failed primary answer into a pass.
            try {
              const report = await interrogate(parentKey, `DIAGNOSTIC_${id}`, 90_000);
              record("diagnostic-after-primary-failure", { sessionKey: parentKey, report });
            } catch (diagnosticError) {
              record("diagnostic-failed", {
                error:
                  diagnosticError instanceof Error
                    ? diagnosticError.message
                    : String(diagnosticError),
              });
            }
            throw error;
          }
        },
      );
    },
    15 * 60_000,
  );
});
