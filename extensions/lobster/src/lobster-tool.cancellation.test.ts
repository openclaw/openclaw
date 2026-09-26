import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import type { OpenClawPluginApi } from "../runtime-api.js";
import * as lobsterRunner from "./lobster-runner.js";
import { fakeApi, fakeCtx } from "./lobster-tool.test-support.js";

const requireRecord = createRequireRecord("record", "expected-label-record");

describe("registered Lobster cancellation", () => {
  it("preserves a newer approval checkpoint when an earlier runner returns cancellation", async () => {
    await withTempHome(async () => {
      const fixture = createPluginRegistryFixture();
      let runtime: OpenClawPluginApi["runtime"] | undefined;
      registerVirtualTestPlugin({
        ...fixture,
        id: "lobster",
        name: "Lobster",
        contracts: manifest.contracts,
        register(api) {
          runtime = api.runtime;
          plugin.register(api);
        },
      });
      if (!runtime) {
        throw new Error("Expected registered runtime");
      }
      const ctx = fakeCtx({ sessionKey: "agent:main:lobster-stale-outcome" });
      const flows = runtime.tasks.async.managedFlows.fromToolContext(ctx);
      const entered = createDeferred<void>();
      const finish = createDeferred<Awaited<ReturnType<lobsterRunner.LobsterRunner["run"]>>>();
      const runner = {
        run: vi.fn<lobsterRunner.LobsterRunner["run"]>(() => {
          entered.resolve();
          return finish.promise;
        }),
      };
      const factory = vi
        .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
        .mockReturnValue(runner);
      let pending: Promise<unknown> | undefined;
      try {
        const tool = fixture.registry.registry.tools[0]?.factory(ctx);
        if (!tool || Array.isArray(tool)) {
          throw new Error("Expected registered tool");
        }
        pending = tool
          .execute("older-run", {
            action: "run",
            pipeline: "noop",
            flowControllerId: "tests/older-run",
            flowGoal: "Synthetic workflow",
          })
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Runner did not start");
          }),
        ]);
        const original = await flows.findLatest();
        if (!original) {
          throw new Error("Expected original managed flow");
        }
        const newer = await flows.setWaiting({
          flowId: original.flowId,
          expectedRevision: original.revision,
          waitJson: { kind: "newer-checkpoint" },
        });
        expect(newer.applied).toBe(true);
        finish.resolve({ ok: true, status: "cancelled", output: [], requiresApproval: null });
        expect(await pending).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining("Flow changed while cancellation"),
          }),
        });
        await expect(flows.get(original.flowId)).resolves.toMatchObject({
          status: "waiting",
          waitJson: { kind: "newer-checkpoint" },
          revision: original.revision + 1,
        });
        expect((await flows.get(original.flowId))?.cancelRequestedAt).toBeUndefined();
      } finally {
        finish.resolve({ ok: true, status: "cancelled", output: [], requiresApproval: null });
        await pending;
        factory.mockRestore();
      }
    });
  });

  it("refuses managed work before effects on older hosts while ordinary workflows remain usable", async () => {
    const runtime = createPluginRuntimeMock();
    const ctx = fakeCtx();
    const bound = runtime.tasks.async.managedFlows.fromToolContext(ctx);
    delete bound.cancel;
    vi.mocked(runtime.tasks.async.managedFlows.fromToolContext).mockReturnValue(bound);
    const runner = {
      run: vi
        .fn<lobsterRunner.LobsterRunner["run"]>()
        .mockResolvedValue({ ok: true, status: "ok", output: [], requiresApproval: null }),
    };
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue(runner);
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    try {
      plugin.register(fakeApi({ runtime, registerTool }));
      const factory = registerTool.mock.calls[0]?.[0];
      if (typeof factory !== "function") {
        throw new Error("Expected the registered Lobster tool factory");
      }
      const tool = factory(ctx);
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected a bound Lobster tool");
      }
      for (const params of [
        {
          action: "run",
          pipeline: "noop",
          flowControllerId: "tests/lobster",
          flowGoal: "Synthetic workflow",
        },
        { action: "resume", flowId: "flow-1", flowExpectedRevision: 1, approve: false },
      ]) {
        await expect(tool.execute("unsupported-managed", params)).rejects.toThrow(
          "Upgrade OpenClaw",
        );
      }
      expect(bound.tryCreateManaged).not.toHaveBeenCalled();
      expect(bound.get).not.toHaveBeenCalled();
      expect(bound.resume).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      await expect(
        tool.execute("ordinary", { action: "run", pipeline: "noop" }),
      ).resolves.toMatchObject({ details: { status: "ok" } });
      expect(runner.run).toHaveBeenCalledOnce();
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it.each(["run", "resume"] as const)(
    "persists childless cancellation through registered managed %s without host data SQL",
    async (action) => {
      await withTempHome(async () => {
        const fixture = createPluginRegistryFixture();
        let runtime: OpenClawPluginApi["runtime"] | undefined;
        registerVirtualTestPlugin({
          ...fixture,
          id: "lobster",
          name: "Lobster",
          contracts: manifest.contracts,
          register(api) {
            runtime = api.runtime;
            plugin.register(api);
          },
        });
        if (!runtime) {
          throw new Error("Expected the registered plugin runtime");
        }
        const ctx = fakeCtx({ sessionKey: `agent:main:lobster-cancel-${action}` });
        const bound = runtime.tasks.async.managedFlows.fromToolContext(ctx);
        // Admit the database and both registries before measuring the tool's runtime work.
        await bound.list();
        await runtime.tasks.async.runs.fromToolContext(ctx).list();
        const runner = {
          run: vi.fn<lobsterRunner.LobsterRunner["run"]>().mockResolvedValue({
            ok: true,
            status: "cancelled",
            output: [],
            requiresApproval: null,
          }),
        };
        if (action === "resume") {
          runner.run.mockResolvedValueOnce({
            ok: true,
            status: "needs_approval",
            output: [],
            requiresApproval: {
              type: "approval_request",
              prompt: "Approve this synthetic workflow?",
              items: [],
              resumeToken: "resume-cancel",
            },
          });
        }
        const runnerFactory = vi
          .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
          .mockReturnValue(runner);
        // After warmup, measure the factory, full managed workflow, and persisted readback.
        const observation = observeHostDataSql();
        try {
          const tool = fixture.registry.registry.tools[0]?.factory(ctx);
          if (!tool || Array.isArray(tool)) {
            throw new Error("Expected a registered Lobster tool");
          }
          let result = await tool.execute("managed-run", {
            action: "run",
            pipeline: "noop",
            flowControllerId: "tests/lobster",
            flowGoal: "Cancel synthetic workflow",
          });
          if (action === "resume") {
            const started = requireRecord(result.details, "waiting workflow");
            const mutation = requireRecord(started.mutation, "waiting mutation");
            const waiting = requireRecord(mutation.flow, "waiting flow");
            expect(waiting.status).toBe("waiting");
            result = await tool.execute("deny-approval", {
              action: "resume",
              approve: false,
              flowId: waiting.flowId,
              flowExpectedRevision: waiting.revision,
            });
            expect(runner.run).toHaveBeenLastCalledWith(
              expect.objectContaining({
                action: "resume",
                token: "resume-cancel",
                approve: false,
              }),
            );
          }
          expect(result).toMatchObject({
            details: {
              ok: true,
              status: "cancelled",
              mutation: { found: true, cancelled: true, tasks: [] },
            },
          });
          const details = requireRecord(result.details, "cancelled workflow");
          const flow = requireRecord(details.flow, "cancelled flow");
          expect(typeof flow.flowId).toBe("string");
          if (typeof flow.flowId !== "string") {
            throw new Error("Expected the cancelled flow ID");
          }
          await expect(bound.get(flow.flowId)).resolves.toMatchObject({
            flowId: flow.flowId,
            status: "cancelled",
            cancelRequestedAt: expect.any(Number),
            endedAt: expect.any(Number),
          });
          expect(observation.queries.length).toBe(0);
        } finally {
          observation.restore();
          runnerFactory.mockRestore();
        }
      });
    },
  );
});
