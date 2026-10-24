import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  bindCronJobAdmittedRun,
  clearCronJobActive,
  markCronJobActive,
} from "../cron/active-jobs.js";
import { captureExecRequestOwners, withExecRequestTurn } from "../infra/exec-request-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

// Real child processes wait on filesystem gates, so the test controls the side-effect
// boundary without sleeps, provider calls, mocked supervisors, or process-kill assertions.
describe("physical cron background exec lifetime", () => {
  for (const terminal of ["timeout", "completion"] as const) {
    it(`keeps a background child bound to occurrence ${terminal} after its original turn closes`, async ({
      signal,
    }) => {
      await withOpenClawTestState({ label: `physical-cron-${terminal}` }, async (state) => {
        const child = await state.writeText(
          "child.cjs",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const [effect, gate] = process.argv.slice(2);",
            "const watcher = fs.watch(path.dirname(gate), (_event, name) => {",
            "  if (String(name) !== path.basename(gate) || !fs.existsSync(gate)) return;",
            "  watcher.close(); fs.writeFileSync(effect, 'SIDE_EFFECT'); process.exit(0);",
            "});",
            "process.stdout.write('READY\\n');",
          ].join("\n"),
        );
        const jobId = "physical-maintenance";
        const identity = {
          runId: "original-cron-turn",
          agentId: "main",
          sessionId: "cron-occurrence",
          sessionKey: `agent:main:cron:${jobId}:run:cron-occurrence`,
        };
        const marker = markCronJobActive(jobId, { agentId: "main" });
        const cron = new AbortController();
        const admission = prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef(identity.runId),
          facts: {
            runId: identity.runId,
            agentId: "main",
            ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          },
        });
        bindCronJobAdmittedRun(marker, await admission.admit("embedded"), cron.signal);
        const launch = async (label: string, sessionKey?: string) => {
          const ready = createDeferredCore();
          const effect = state.path(`${label}-effect`);
          const gate = state.path(`${label}-release`);
          const run = await runExecProcess({
            command: label,
            workdir: state.root,
            env: {},
            usePty: false,
            warnings: [],
            maxOutput: 1_000,
            pendingMaxOutput: 1_000,
            notifyOnExit: false,
            timeoutSec: 10,
            agentId: "main",
            sessionKey,
            requestOwners: sessionKey ? captureExecRequestOwners(identity) : undefined,
            onUpdate: (update) => {
              if (
                update.content.some((part) => part.type === "text" && part.text.includes("READY"))
              ) {
                ready.resolve();
              }
            },
            sandbox: {
              containerName: "synthetic-native-child",
              workspaceDir: state.root,
              containerWorkdir: state.root,
              buildExecSpec: async () => ({
                argv: [process.execPath, child, effect, gate],
                env: {},
                stdinMode: "pipe-closed",
              }),
            },
          });
          await withinTest(ready.promise, signal);
          markBackgrounded(run.session);
          return { run, effect, gate };
        };
        const owned = await withExecRequestTurn({ identity, abortSignal: cron.signal }, () =>
          launch("cron", identity.sessionKey),
        );
        admission.close();
        const interactive = await launch("interactive");
        try {
          if (terminal === "timeout") {
            const error = new Error("cron: job execution timed out");
            error.name = "TimeoutError";
            cron.abort(error);
          } else {
            clearCronJobActive(jobId, marker);
          }
          if (terminal === "timeout") {
            expect(owned.run.session.requestCancelled).toBe(true);
            // Native settlement must precede releasing the side-effect gate.
            await expect(withinTest(owned.run.promise, signal)).resolves.toMatchObject({
              status: "failed",
              exitReason: "manual-cancel",
            });
            await fs.writeFile(owned.gate, "release");
            await expect(fs.stat(owned.effect)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(owned.run.session.requestCancelled).not.toBe(true);
            await fs.writeFile(owned.gate, "release");
            await expect(withinTest(owned.run.promise, signal)).resolves.toMatchObject({
              status: "completed",
            });
            expect(await fs.readFile(owned.effect, "utf8")).toBe("SIDE_EFFECT");
          }
          expect(owned.run.session.aggregated).toContain("READY");
          expect(interactive.run.session.requestCancelled).not.toBe(true);
          expect(interactive.run.session.exited).toBe(false);
          await fs.writeFile(interactive.gate, "release");
          await expect(withinTest(interactive.run.promise, signal)).resolves.toMatchObject({
            status: "completed",
          });
          expect(await fs.readFile(interactive.effect, "utf8")).toBe("SIDE_EFFECT");
        } finally {
          await Promise.all([
            fs.writeFile(owned.gate, "release"),
            fs.writeFile(interactive.gate, "release"),
          ]);
          await Promise.all([owned.run.promise, interactive.run.promise]);
          cron.abort();
          clearCronJobActive(jobId, marker);
          admission.close();
          resetProcessRegistryForTests();
        }
      });
    });
  }
});
