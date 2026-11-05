import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { registerSandboxBackend } from "../../sandbox/backend.js";
import * as workspaceSandbox from "../../workspace-sandbox.js";
import { createDispatchSandboxBackend as backend } from "./run-attempt-dispatch.cases.test-support.js";

it.each(["settled", "failed", "revoked", "unsandboxed"] as const)(
  "settles attribution before a writable sandbox setup (%s)",
  async (outcome) => {
    await withOpenClawTestState({ label: "baseline-sandbox" }, async (state) => {
      const config = {
        agents: {
          defaults: {
            sandbox: {
              mode: outcome === "unsandboxed" ? ("off" as const) : ("all" as const),
              backend: "baseline-fixture",
              workspaceAccess: "rw" as const,
              browser: { enabled: false },
            },
          },
        },
      };
      const entered = createDeferred();
      const baseline = createDeferred();
      const setupFile = path.join(state.workspaceDir, "setup.txt");
      const factory = vi.fn(async () => {
        await fs.writeFile(setupFile, "sandbox setup");
        return backend("baseline-fixture", "/workspace");
      });
      const restoreBackend = registerSandboxBackend("baseline-fixture", factory);
      const admission = prepareSystemAgentRunAdmission(config, "baseline", "main", "test");
      const pending = workspaceSandbox.resolveAttemptWorkspaceSandbox({
        config,
        agentId: "main",
        sessionId: "baseline",
        sessionKey: "agent:main:baseline",
        workspaceDir: state.workspaceDir,
        admittedRunContext: await admission.admit("embedded"),
        awaitSessionDiffBaseline: () => {
          entered.resolve();
          return baseline.promise;
        },
      });
      void pending.catch(() => {});
      try {
        if (outcome === "unsandboxed") {
          await awaitGateBeforeSettlement(pending, entered.promise, "Unsandboxed setup waited");
          expect(factory).not.toHaveBeenCalled();
          return;
        }
        await awaitGateBeforeSettlement(entered.promise, pending, "Sandbox bypassed attribution");
        expect(factory).not.toHaveBeenCalled();
        await expect(fs.stat(setupFile)).rejects.toMatchObject({ code: "ENOENT" });
        if (outcome === "failed") {
          const failure = new Error("capture failed");
          baseline.reject(failure);
          await expect(pending).rejects.toBe(failure);
        } else {
          if (outcome === "revoked") {
            admission.close();
          }
          baseline.resolve();
          if (outcome === "revoked") {
            await expect(pending).rejects.toThrow("admitted run authority is no longer active");
          } else {
            await pending;
            expect(await fs.readFile(setupFile, "utf8")).toBe("sandbox setup");
          }
        }
        expect(factory).toHaveBeenCalledTimes(outcome === "settled" ? 1 : 0);
      } finally {
        baseline.resolve();
        await pending.catch(() => undefined);
        admission.close();
        restoreBackend();
      }
    });
  },
);
