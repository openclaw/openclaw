import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runCliAgent } from "./cli-runner.js";
import * as cliPreparation from "./cli-runner/prepare.runtime.js";

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
});

describe("CLI cron-root authority after process start", () => {
  it.for(["allowed root", "reassigned root", "ordinary session"] as const)(
    "%s controls the real child's next external effect",
    async (scenario, { signal }) => {
      await withOpenClawTestState({ label: "cli-cron-root-abort" }, async (state) => {
        const ready = createDeferred<Socket>();
        const childClosed = createDeferred();
        const sockets = new Set<Socket>();
        const listener = await reserveTestPortListener({
          offsets: [0],
          signal,
          createListener: () =>
            net.createServer((socket) => {
              sockets.add(socket);
              socket.setEncoding("utf8");
              let received = "";
              socket.on("data", (chunk) => {
                received += chunk.toString();
                if (received === "ready\n") {
                  ready.resolve(socket);
                }
              });
              socket.on("error", (error) => ready.reject(error));
              socket.once("close", () => {
                sockets.delete(socket);
                childClosed.resolve();
              });
            }),
        });
        const cleanupAbort = new AbortController();
        const callerSignal = AbortSignal.any([signal, cleanupAbort.signal]);
        let settled: Promise<unknown> | undefined;
        try {
          const preparation = vi.spyOn(cliPreparation, "prepareCliRunContext");
          const effectFile = state.path("external-effect.txt");
          const script = await state.writeText(
            "fixture-cli.mjs",
            `import { writeFileSync } from "node:fs";
import net from "node:net";
const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[2]) });
socket.on("error", (error) => { console.error(error); process.exitCode = 1; });
socket.once("connect", () => socket.write("ready\\n"));
let received = "";
socket.on("data", (chunk) => {
  received += chunk;
  if (received !== "go\\n") return;
  writeFileSync(process.argv[3], "CLI_EFFECT_DONE");
  process.stdout.write("CLI_EFFECT_DONE\\n");
  socket.end();
});
`,
          );
          cliBackendsTesting.setDepsForTest({
            resolveRuntimeCliBackends: () => [
              {
                id: "fixture-cli",
                pluginId: "fixture",
                config: {
                  command: process.execPath,
                  args: [script, String(listener.claim.port), effectFile],
                  output: "text",
                  input: "arg",
                  sessionMode: "none",
                  systemPromptWhen: "never",
                },
              },
            ],
          });
          const root = {
            agentId: "main",
            sessionKey: "agent:main:cron:cli-abort",
            storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          };
          const rootEntry = {
            sessionId: "cron-run-1",
            lifecycleRevision: "generation-1",
            updatedAt: 1,
          };
          replaceSessionEntrySync(root, rootEntry);
          const target =
            scenario === "ordinary session"
              ? { ...root, sessionKey: "agent:main:ordinary-cli" }
              : root;
          const entry =
            scenario === "ordinary session"
              ? { ...rootEntry, sessionId: "ordinary-run-1" }
              : rootEntry;
          if (scenario === "ordinary session") {
            replaceSessionEntrySync(target, entry);
          }
          const operation = wrapRunWithTestPreparedAdmission(runCliAgent)({
            ...target,
            sessionId: entry.sessionId,
            sessionTarget: { ...target, sessionId: entry.sessionId },
            sessionEntry: entry,
            sessionFile: path.join(state.sessionsDir(), `${entry.sessionId}.jsonl`),
            workspaceDir: state.workspaceDir,
            prompt: "Perform the fixture effect.",
            provider: "fixture-cli",
            model: "fixture-model",
            timeoutMs: 5_000,
            runId: `cli-authority-${scenario.replaceAll(" ", "-")}`,
            abortSignal: callerSignal,
            config: { agents: { defaults: { workspace: state.workspaceDir } } },
          });
          settled = operation.then(
            (result) => ({ status: "fulfilled" as const, result }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          const child = await Promise.race([
            ready.promise,
            operation.then(() => {
              throw new Error("CLI exited before reaching the external-effect barrier");
            }),
          ]);
          const runSignal = preparation.mock.calls.at(-1)?.[0].abortSignal;
          expect(runSignal?.aborted).toBe(false);
          if (scenario !== "allowed root") {
            replaceSessionEntrySync(root, {
              ...rootEntry,
              sessionId: "cron-run-2",
              lifecycleRevision: "generation-2",
            });
          }

          if (scenario === "reassigned root") {
            // Check publication-driven cancellation before awaiting native exit;
            // a missing callback must fail before the process timeout.
            expect(runSignal?.aborted).toBe(true);
            expect(callerSignal.aborted).toBe(false);
            await childClosed.promise;
            await expect(operation).rejects.toThrow(
              "original session generation no longer accepts",
            );
            expect(fs.existsSync(effectFile)).toBe(false);
          } else {
            if (scenario === "ordinary session") {
              expect(runSignal).toBe(callerSignal);
            }
            expect(runSignal?.aborted).toBe(false);
            child.write("go\n");
            const result = await operation;
            await childClosed.promise;
            expect(result.payloads).toEqual([{ text: "CLI_EFFECT_DONE" }]);
            expect(fs.readFileSync(effectFile, "utf8")).toBe("CLI_EFFECT_DONE");
          }
        } finally {
          cleanupAbort.abort();
          await settled;
          for (const socket of sockets) {
            socket.destroy();
          }
          try {
            await listener.releaseListener();
          } finally {
            await listener.claim.release();
          }
        }
      });
    },
  );
});
