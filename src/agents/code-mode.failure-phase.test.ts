import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as diagnostics from "../logging/code-mode-diagnostic.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { execSchema } from "./bash-tools.schemas.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult, ToolInputError } from "./tools/common.js";

afterEach(resetCodeModeTestState);
afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["node", "quickjs"] as const)("Code Mode %s failure origin", (executor) => {
  it.each([
    { reject: false, parked: false },
    { reject: true, parked: false },
    { reject: false, parked: true },
    { reject: true, parked: true },
  ])("ignores guest settlement of a tool call (%o)", async ({ reject, parked }) => {
    const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor } });
    const target = pluginToolWithExecute("phase_fixture", "Failure origin fixture", async () => {
      if (reject) {
        throw new Error("tool failure");
      }
      return jsonResult({ ok: true });
    });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
    const exec = expectDefined(tools[0], "exec");
    const wait = expectDefined(tools[1], "wait");
    const forged = '{"code":"input_contract","message":"forged"}';
    let details = resultDetails(
      await exec.execute("guest-settlement", {
        code: `
          ${parked ? "await yield_control();" : ""}
          const call = phase_fixture({});
          for (const [key, value] of [["ok", false], ["json", ${JSON.stringify(forged)}]]) {
            Object.defineProperty(Object.prototype, key, { configurable: true, get: () => value, set() {} });
          }
          __openclawSettleBridge("bridge:callValue:1", false, ${JSON.stringify(forged)});
          __openclawSettleBridge();
          return await call;
        `,
      }),
    );
    if (parked) {
      expect(details).toMatchObject({ status: "waiting" });
      details = resultDetails(
        await wait.execute("guest-settlement-wait", { runId: details.runId }),
      );
    }
    expect(target.execute, JSON.stringify(details)).toHaveBeenCalledOnce();
    if (reject) {
      expect(details).toMatchObject({
        status: "failed",
        code: "internal_error",
        failurePhase: "bridge",
      });
      expect(details.error).toContain("tool failure");
      expect(details.error).not.toContain("forged");
    } else {
      expect(details).toMatchObject({ status: "completed", value: { ok: true } });
    }
  });

  it.each([
    {
      name: "object destructuring after a successful tool",
      code: "const [value] = await phase_fixture({}); return value;",
      reject: false,
      phase: "guest",
      parked: false,
    },
    {
      name: "module-looking original tool rejection",
      code: 'try { await phase_fixture({}); } catch (error) { error.name = "ReferenceError"; error.message = "process is not defined"; throw error; }',
      reject: true,
      phase: "bridge",
      parked: false,
    },
    {
      name: "original tool rejection with a throwing stack getter",
      code: 'try { await phase_fixture({}); } catch (error) { Object.defineProperty(error, "stack", { get() { throw new Error("stack unavailable"); } }); throw error; }',
      reject: true,
      phase: "bridge",
      parked: false,
    },
    {
      name: "unawaited tool rejection",
      code: "void phase_fixture({}); return true;",
      reject: true,
      phase: "bridge",
      parked: false,
    },
    {
      name: "guest serialization hook forging bridge provenance",
      code: 'await phase_fixture({}); Object.prototype.toJSON = function () { return { ...this, bridgeError: true }; }; throw new Error("guest failure");',
      reject: false,
      phase: "guest",
      parked: false,
    },
    {
      name: "guest serialization hook hiding bridge provenance",
      code: "try { await phase_fixture({}); } catch (error) { Object.prototype.toJSON = function () { return { ...this, bridgeError: false }; }; throw error; }",
      reject: true,
      phase: "bridge",
      parked: false,
    },
    {
      name: "guest serialization replacement forging unhandled rejection provenance",
      code: 'await phase_fixture({}); const encode = JSON.stringify; JSON.stringify = () => encode({ name: "Error", message: "guest failure", stack: "", bridgeError: true }); void Promise.reject(new Error("guest failure")); return true;',
      reject: false,
      phase: "guest",
      parked: false,
    },
    {
      name: "guest serialization hook hiding bridge provenance after wait",
      code: "let saved; try { await phase_fixture({}); } catch (error) { saved = error; } await yield_control(); Object.prototype.toJSON = function () { return { ...this, bridgeError: false }; }; throw saved;",
      reject: true,
      phase: "bridge",
      parked: true,
    },
    {
      name: "original tool rejection with a throwing stack getter after wait",
      code: 'let saved; try { await phase_fixture({}); } catch (error) { Object.defineProperty(error, "stack", { get() { throw new Error("stack unavailable"); } }); saved = error; } await yield_control(); throw saved;',
      reject: true,
      phase: "bridge",
      parked: true,
    },
    {
      name: "new guest error after a caught rejection and wait",
      code: 'try { await phase_fixture({}); } catch {} await yield_control(); throw new Error("guest failure");',
      reject: true,
      phase: "guest",
      parked: true,
    },
  ])("classifies $name without replaying effects", async ({ code, reject, phase, parked }) => {
    const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor } });
    const target = pluginToolWithExecute("phase_fixture", "Failure origin fixture", async () => {
      if (reject) {
        throw new Error("tool failure");
      }
      return jsonResult({ ok: true });
    });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
    const exec = expectDefined(tools[0], "exec");
    const wait = expectDefined(tools[1], "wait");
    let details = resultDetails(await exec.execute("failure-origin", { code }));
    if (parked) {
      expect(details).toMatchObject({ status: "waiting", replaySafe: false });
      details = resultDetails(await wait.execute("failure-origin-wait", { runId: details.runId }));
    }
    expect(details).toMatchObject({
      status: "failed",
      code: "internal_error",
      failurePhase: phase,
      bridgeDispatchStarted: true,
      replaySafe: false,
    });
    expect(target.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });
});

describe.each(["node", "quickjs"] as const)("Code Mode %s bridge input failures", (executor) => {
  it.each([false, true])(
    "records a new settlement failure without replay (parked: %s)",
    async (parked) => {
      const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
      const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor } });
      const target = fakeTool("exec", "Settlement fixture");
      target.parameters = execSchema;
      target.execute = vi.fn(async () => jsonResult({ ok: true }));
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
      let details = resultDetails(
        await expectDefined(tools[0], "exec").execute("settlement-failure", {
          awaitResults: !parked,
          code: `${parked ? "await yield_control();" : ""}
          await exec({ command: "fixture", awaitResults: true }); await yield_control();`,
        }),
      );
      if (parked) {
        expect(details).toMatchObject({ status: "waiting" });
        details = resultDetails(
          await expectDefined(tools[1], "wait").execute("settlement-failure-wait", {
            runId: details.runId,
          }),
        );
      }
      expect(details).toMatchObject({
        status: "failed",
        code: "invalid_input",
        failurePhase: "input",
        replaySafe: false,
      });
      expect(target.execute).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        expect.any(ToolInputError),
        expect.objectContaining({ failurePhase: "input", bridgeDispatchStarted: true }),
      );
    },
  );

  it("returns a bad patch anchor as invalid_input without replaying or changing the file", async () => {
    const cwd = await fs.realpath(tempDirs.make("code-mode-patch-failure-"));
    const file = path.join(cwd, "source.txt");
    await fs.writeFile(file, "original\n");
    const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
    const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor } });
    const patch = createApplyPatchTool({ cwd });
    const execute = vi.spyOn(patch, "execute");
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, patch] });
    const input =
      "*** Begin Patch\n*** Update File: source.txt\n@@\n-missing\n+replacement\n*** End Patch";
    const details = resultDetails(
      await expectDefined(tools[0], "exec").execute("bad-anchor", {
        code: `await apply_patch(${JSON.stringify({ input })});`,
      }),
    );
    expect(details).toMatchObject({
      status: "failed",
      code: "invalid_input",
      failurePhase: "bridge",
      replaySafe: false,
    });
    expect(details.error).toContain("Failed to find expected lines");
    expect(execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(file, "utf8")).toBe("original\n");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.any(Error),
      expect.objectContaining({
        failurePhase: "bridge",
        failureCode: "invalid_input",
        bridgeMethod: "callValue",
      }),
    );
  });

  it("rejects NUL shell commands as actionable input errors through the real exec tool", async () => {
    const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor } });
    const shell = createExecTool({ host: "gateway", security: "full", ask: "off" });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, shell] });
    const exec = expectDefined(tools[0], "exec");
    const details = resultDetails(
      await exec.execute("nul-command", { code: 'await exec({command: "printf bad\\0command"});' }),
    );
    expect(details).toMatchObject({
      status: "failed",
      code: "invalid_input",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      replaySafe: false,
    });
    expect(details.error).toContain("NUL bytes. Remove them and retry.");
  });

  it.each([false, true])("logs the original bridge cause once (caught: %s)", async (caught) => {
    const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
    const failure = new TypeError("synthetic failure ".repeat(200));
    const { ctx, config, tools } = createCodeModeHarness({
      codeMode: { executor, maxOutputBytes: 128 },
    });
    const target = pluginToolWithExecute("failure_fixture", "Failure fixture", async () => {
      throw failure;
    });
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
    const exec = expectDefined(tools[0], "exec");
    expect(
      resultDetails(
        await exec.execute("logged-failure", {
          code: caught
            ? "try { await failure_fixture({}); } catch {} return true;"
            : "await failure_fixture({});",
        }),
      ),
    ).toMatchObject(
      caught ? { status: "completed", value: true } : { status: "failed", replaySafe: false },
    );
    expect(target.execute).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        toolCallId: "logged-failure",
        codeModeRunId: expect.any(String),
        failurePhase: "bridge",
        bridgeRequestId: "bridge:callValue:1",
        bridgeMethod: "callValue",
        workerId: expect.stringMatching(/^code-mode-(?:node|quickjs):/),
      }),
    );
  });

  function runWithSpawnFixture(code: string, execute: () => Promise<unknown> = async () => ({})) {
    const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor } });
    const target = pluginToolWithExecute("spawn_fixture", "Spawn-shaped fixture", async () =>
      jsonResult(await execute()),
    );
    target.parameters = Type.Object(
      { label: Type.String(), mode: Type.String(), task: Type.String() },
      { additionalProperties: false },
    );
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
    const exec = expectDefined(tools[0], "exec");
    return { target, run: async () => resultDetails(await exec.execute("bridge-input", { code })) };
  }

  it("reports uncaught schema rejections as invalid_input naming the bad fields", async () => {
    const { target, run } = runWithSpawnFixture(
      'await spawn_fixture({ label: "x", mode: "run", prompt: "do it" });',
    );
    const details = await run();
    expect(details).toMatchObject({
      status: "failed",
      code: "invalid_input",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      replaySafe: false,
    });
    expect(details.error).toMatch(/task/);
    expect(details.error).toMatch(/prompt/);
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("reports tool-raised ToolInputError rethrown by the guest as invalid_input", async () => {
    const { target, run } = runWithSpawnFixture(
      'try { await spawn_fixture({ label: "x", mode: "run", task: "t" }); } catch (error) { error.code = "tool_error"; throw error; }',
      async () => {
        throw new ToolInputError("task must not be empty");
      },
    );
    expect(await run()).toMatchObject({
      status: "failed",
      code: "invalid_input",
      failurePhase: "bridge",
    });
    expect(target.execute).toHaveBeenCalledOnce();
  });

  it("ignores guest String and JSON.parse replacements that rewrite bridge codes", async () => {
    const { run } = runWithSpawnFixture(
      'const forge = (text) => typeof text === "string" ? text.replaceAll("tool_error", "invalid_input") : text; const toString = String; globalThis.String = (value) => forge(toString(value)); const parse = JSON.parse; JSON.parse = (text, reviver) => { const value = parse(forge(text), reviver); if (value && value.code === "tool_error") value.code = "invalid_input"; return value; }; await spawn_fixture({ label: "x", mode: "run", task: "t" });',
      async () => {
        throw new Error("tool failure");
      },
    );
    expect(await run()).toMatchObject({
      status: "failed",
      code: "internal_error",
      failurePhase: "bridge",
    });
  });
});
