import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import * as worker from "./code-mode-executor.js";
import type { CodeModeSkill } from "./code-mode-skills.js";
import type { SettledBridgeRequest } from "./code-mode-worker-types.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  waitUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "./tools/common.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

async function runCode(code: string, targets: AnyAgentTool[]) {
  const { ctx, tools } = createCodeModeHarness();
  applyCodeModeCatalog({
    tools: [...tools, ...targets],
    ...ctx,
  });
  return resultDetails(await tools[0]!.execute("preflight", { code }));
}

describe("Code Mode preflight repair", () => {
  it.each([
    { kind: "input", code: "input_contract", calls: 0 },
    { kind: "schema", code: "invalid_contract", calls: 0 },
    { kind: "throw", code: "invalid_input", calls: 1 },
    { kind: "spoof", code: "tool_error", calls: 1 },
  ])("classifies $kind failures without inferring safe retry", async ({ kind, code, calls }) => {
    const target = pluginToolWithExecute("contract_target", "Contract boundary", async () => {
      if (kind === "throw") {
        throw new ToolInputError("already started");
      }
      if (kind === "spoof") {
        throw Object.assign(new Error("already started"), {
          code: "input_contract",
          effectStatus: "none",
        });
      }
      return jsonResult({ count: "wrong" });
    });
    target.parameters = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    target.outputSchema =
      kind === "schema"
        ? ({ type: "not-a-type" } as never)
        : Type.Object({ count: Type.Number() }, { additionalProperties: false });
    const result = await runCode(
      "try { await contract_target({ count: " +
        (kind === "input" ? '"wrong"' : "1") +
        " }); } catch (e) { return { code: e.code, effectStatus: e.effectStatus, location: e.location, message: e.message }; }",
      [target],
    );
    expect(result).toMatchObject({
      status: "completed",
      value: {
        code,
        effectStatus: "unknown",
        location: expect.stringContaining("openclaw-code-mode:user.js:1:"),
      },
    });
    expect(target.execute).toHaveBeenCalledTimes(calls);
  });

  it("reports bounded output validation details after a mutation without exposing returned values", async () => {
    let applied = 0;
    const privateValue = "SYNTHETIC_PRIVATE_OUTPUT";
    const fields = [
      "field0",
      "long_" + "🦞".repeat(600),
      ...Array.from({ length: 6 }, (_, index) => `field${index + 2}`),
    ];
    const target = pluginToolWithExecute(
      "update_receipt",
      "Update a synthetic receipt",
      async () => {
        applied += 1;
        return jsonResult({
          receipt: Object.fromEntries(fields.map((field) => [field, privateValue])),
        });
      },
    );
    target.outputSchema = Type.Object(
      {
        receipt: Type.Object(Object.fromEntries(fields.map((field) => [field, Type.Number()]))),
      },
      { additionalProperties: false },
    );

    const details = await runCode(
      "try { await update_receipt({}); } catch (e) { return { code:e.code, effectStatus:e.effectStatus, message:e.message }; }",
      [target],
    );

    expect(applied).toBe(1);
    expect(target.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "completed",
      value: {
        code: "output_contract",
        effectStatus: "unknown",
        message: expect.stringContaining("receipt.field0: must be number"),
      },
    });
    const message = JSON.stringify(details.value);
    expect(message).toContain("tool returned");
    expect(message).toContain("Check current state before retrying");
    expect(message).toContain("additional validation issues omitted");
    expect(message).toContain("[truncated]");
    expect(message).not.toContain(privateValue);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThan(2048);
  });

  it("rejects stale exec timeout input before starting the command", async () => {
    const exec = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const execute = vi.spyOn(exec, "execute");

    const details = await runCode('await exec({ command: "printf ok", timeout: 5 });', [exec]);

    expect(execute).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(details.error).toContain("timeout");
  });

  it.each([
    {
      label: "guest failure after a successful call",
      phase: "guest",
      execute: async () => jsonResult({ ok: true }),
      code: 'await fake_post_dispatch({}); throw new Error("after dispatch");',
    },
    {
      label: "ToolInputError after implementation start",
      phase: "bridge",
      execute: async () => {
        throw new ToolInputError("implementation already started");
      },
      code: "await fake_post_dispatch({});",
    },
  ])("keeps $label non-retryable", async ({ execute, code, phase }) => {
    const target = pluginToolWithExecute("fake_post_dispatch", "Post-dispatch failure", execute);

    const details = await runCode(code, [target]);

    expect(target.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: phase,
      bridgeDispatchStarted: true,
      replaySafe: false,
    });
  });
});

afterEach(resetCodeModeTestState);

describe("Code Mode program data", () => {
  async function run(tools: AnyAgentTool[], code: string, skills: CodeModeSkill[] = []) {
    const h = createCodeModeHarness({ codeModeSkills: skills, codeMode: { maxOutputBytes: 1024 } });
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [...h.tools, ...createInstalledSkillTools(skills), ...tools],
    });
    return runUntilCompleted({ execTool: h.tools[0]!, waitTool: h.tools[1]!, code });
  }

  it("refuses aggregate overflow across a parked boundary", async () => {
    const bytes = 6 * 1024 * 1024;
    const tool = pluginToolWithExecute("large_page", "Read a large page", async () =>
      jsonResult("x".repeat(bytes)),
    );
    const code =
      "const pages = Promise.allSettled([large_page({}), large_page({})]); " +
      "await yield_control(); " +
      'return (await pages).map(item => item.status === "fulfilled" ? { length: item.value.length } : { error: item.reason.message });';
    const result = await run([tool], code);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: [
        { length: bytes },
        { error: expect.stringMatching(/program-data budget exceeded.*Paginate/) },
      ],
    });
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });

  it.each([4000, 11 * 1024 * 1024])(
    "serves whole skill instructions or refuses admission (%s bytes)",
    async (bytes) => {
      const body = "x".repeat(bytes - 4) + "END!";
      const skill = {
        name: "demo",
        description: "Full instructions",
        location: "/skills/demo/SKILL.md",
        source: { filePath: "/skills/demo/SKILL.md", readContent: body },
      };
      const result = await run(
        [],
        'try { const body = await skills.read("demo"); return { length: body.length, tail: body.slice(-4) }; } catch (error) { return { error: error.message }; }',
        [skill],
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value:
          bytes < 10 * 1024 * 1024
            ? { length: bytes, tail: "END!" }
            : { error: expect.stringMatching(/instruction limit/) },
      });
    },
  );
});

it("clears host and worker-input aliases while retained readiness promises stay payload-free", async () => {
  const original = worker.runCodeModeExecutor;
  const arrays: SettledBridgeRequest[][] = [];
  const aliases: SettledBridgeRequest[] = [];
  const spy = vi.spyOn(worker, "runCodeModeExecutor").mockImplementation(async (input, ...args) => {
    // Production owns the worker input; retain its exact aliases to detect premature accounting-only release.
    const resume = input as { kind: string; settledRequests?: SettledBridgeRequest[] };
    if (resume.kind === "resume" && resume.settledRequests) {
      arrays.push(resume.settledRequests);
      aliases.push(...resume.settledRequests);
    }
    return await original(input, ...args);
  });
  const h = createCodeModeHarness();
  const success = pluginToolWithExecute("reply_success", "Read data", async () =>
    jsonResult("x".repeat(200000)),
  );
  const failure = pluginToolWithExecute("reply_failure", "Fail", async () => {
    throw new Error("failure:" + "x".repeat(200000));
  });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, success, failure] });
  try {
    const first = resultDetails(
      await h.tools[0]!.execute("aliases", {
        code: "const replies = Promise.allSettled([reply_success({}), reply_failure({})]); await yield_control(); return (await replies).map(reply => reply.status);",
      }),
    );
    expect(first.status).toBe("waiting");
    const retainedState = testing.activeRuns.get(String(first.runId))!;
    const ready = await Promise.all(retainedState.pending.map((entry) => entry.promise));
    expect(ready.every((value) => value === undefined)).toBe(true);
    const final = await waitUntilCompleted({ details: first, waitTool: h.tools[1]! });
    expect(final).toMatchObject({ status: "completed", value: ["fulfilled", "rejected"] });
    expect(aliases.some((reply) => reply.ok)).toBe(true);
    expect(aliases.some((reply) => !reply.ok)).toBe(true);
    expect(arrays.every((array) => array.length === 0)).toBe(true);
    expect(aliases.every((reply) => reply.json === "")).toBe(true);
    for (const pending of retainedState.pending) {
      expect(await pending.promise).toBeUndefined();
      expect(() => pending.reply.take()).toThrow("unavailable");
    }
  } finally {
    spy.mockRestore();
    clearToolSearchCatalog(h.ctx);
  }
});

it.each(["cancel", "expiry"])(
  "does not retain a late tool completion after parked %s",
  async (close) => {
    const started = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    const h = createCodeModeHarness();
    const tool = pluginToolWithExecute("late_page", "Signal-ignoring data source", async () => {
      started.resolve();
      await release.promise;
      finished.resolve();
      return jsonResult("late".repeat(300000));
    });
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    try {
      const first = resultDetails(
        await h.tools[0]!.execute("late", {
          code: "const page = late_page({}); await yield_control(); return (await page).length;",
        }),
      );
      expect(first.status).toBe("waiting");
      await started.promise;
      const retained = testing.activeRuns.get(String(first.runId))!;
      if (close === "expiry") {
        testing.removeExpiredRuns(retained.expiresAt + 1);
      } else {
        clearToolSearchCatalog(h.ctx);
      }
      await Promise.all(retained.pending.map((entry) => entry.promise));
      release.resolve();
      await finished.promise;
      await Promise.resolve();
      expect(retained.owner.signal.aborted).toBe(true);
      expect(testing.activeRuns.size).toBe(0);
      for (const pending of retained.pending) {
        expect(() => pending.reply.take()).toThrow("unavailable");
      }
      expect(tool.execute).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      clearToolSearchCatalog(h.ctx);
    }
  },
);

it("releases each guest-discarded timer lease before the cell closes", async () => {
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
  try {
    let result = resultDetails(
      await h.tools[0]!.execute("discarded-timers", {
        code: `for (let i = 0; i < 6; i++) {
        const timer = setTimeout(() => { throw new Error("discarded timer fired"); }, 60_000);
        await yield_control("armed");
        clearTimeout(timer);
        await yield_control("cleared");
      }
      return "done";`,
      }),
    );
    for (let round = 0; round < 6; round++) {
      expect(result.status).toBe("waiting");
      const parked = testing.activeRuns.get(String(result.runId))!;
      const timer = parked.pending.find((entry) => entry.method === "sleep")!;
      expect(timer).toBeDefined();
      expect(timer.settled).toBeUndefined();
      const release = vi.spyOn(timer.reply, "release");
      result = resultDetails(await h.tools[1]!.execute("discard-timer", { runId: result.runId }));
      expect(result.status).toBe("waiting");
      expect(parked.owner.signal.aborted).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(() => timer.reply.take()).toThrow("unavailable");
      expect(
        testing.activeRuns
          .get(String(result.runId))!
          .pending.some((entry) => entry.id === timer.id),
      ).toBe(false);
      release.mockRestore();
      result = resultDetails(await h.tools[1]!.execute("next-timer", { runId: result.runId }));
    }
    expect(result).toMatchObject({ status: "completed", value: "done" });
  } finally {
    clearToolSearchCatalog(h.ctx);
    vi.restoreAllMocks();
  }
});
