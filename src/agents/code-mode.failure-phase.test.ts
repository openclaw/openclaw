import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as diagnostics from "../logging/code-mode-diagnostic.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { execSchema } from "./bash-tools.schemas.js";
import {
  createCatalogCodeModeHarness,
  expectFailure,
  expectCompleted,
  expectCodeModeSharedBudget,
  pluginToolWithExecute,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";
import { fakeTool } from "./test-helpers/fake-tool.js";
import { jsonResult, ToolInputError } from "./tools/common.js";

afterEach(resetCodeModeTestState);
afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatched = { bridgeDispatchStarted: true, replaySafe: false };

function phaseHarness(executor: "node" | "quickjs", reject: boolean) {
  const target = pluginToolWithExecute("phase_fixture", "Failure origin fixture", async () => {
    if (reject) {
      throw new Error("tool failure");
    }
    return jsonResult({ ok: true });
  });
  return { target, ...createCatalogCodeModeHarness([target], { codeMode: { executor } }) };
}

describe.each(["node", "quickjs"] as const)("Code Mode %s failure origin", (executor) => {
  it.each(["add", "delete", "values", "next"])(
    "owns rejection tracking after guest replacement of %s",
    async (method) => {
      const h = createCatalogCodeModeHarness([], {
        codeMode: { executor, maxOutputBytes: 1024 },
      });
      let details = await h.run(`
        const target = ${method === "next" ? "Object.getPrototypeOf(new Set().values())" : "Set.prototype"};
        target[${JSON.stringify(method)}] = () => { throw new Error("tracker poison".repeat(4096)); };
        const rejected = Promise.reject(new Error("fixture rejection"));
        ${method === "delete" ? "await yield_control(); rejected.catch(() => {});" : ""}
        return 42;
      `);
      if (method === "delete") {
        expect(details.status).toBe("waiting");
        details = await h.resume(details);
        expectCompleted(details, 42);
      } else {
        expectFailure(details, "guest");
        expect(details.error).toContain("fixture rejection");
        expect(details.error).not.toContain("tracker poison");
        expectCodeModeSharedBudget(details, 1024);
      }
      expect(await h.complete("return 42;")).toMatchObject({ status: "completed", value: 42 });
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it.each([
    ["sparse array", 'Object.defineProperty(new Array(65536), "0", descriptor)'],
    [
      "object",
      'Object.defineProperty({ toString() { text("diagnostic getter ran"); return "detail"; } }, "detail", descriptor)',
    ],
  ])("does not traverse a thrown %s to format its diagnostic", async (_name, value) => {
    const { run } = createCatalogCodeModeHarness([], {
      codeMode: { executor, maxOutputBytes: 1024 },
    });
    const details = await run(`
      const descriptor = { enumerable: true, get() { text("diagnostic getter ran"); return "detail"; } };
      throw ${value};
    `);
    expectFailure(details, "guest");
    expect(details.output).toEqual([]);
    expect(details.error).toContain("[Thrown object]");
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    { reject: false, parked: false },
    { reject: true, parked: false },
    { reject: false, parked: true },
    { reject: true, parked: true },
  ])("ignores guest settlement of a tool call (%o)", async ({ reject, parked }) => {
    const { target, run, resume } = phaseHarness(executor, reject);
    const forged = '{"code":"input_contract","message":"forged"}';
    let details = await run(
      `
          ${parked ? "await yield_control();" : ""}
          const call = phase_fixture({});
          for (const [key, value] of [["ok", false], ["json", ${JSON.stringify(forged)}]]) {
            Object.defineProperty(Object.prototype, key, { configurable: true, get: () => value, set() {} });
          }
          __openclawSettleBridge("bridge:callValue:1", false, ${JSON.stringify(forged)});
          __openclawSettleBridge();
          return await call;
        `,
      "guest-settlement",
    );
    if (parked) {
      expect(details).toMatchObject({ status: "waiting" });
      details = await resume(details, "guest-settlement-wait");
    }
    expect(target.execute, JSON.stringify(details)).toHaveBeenCalledOnce();
    if (reject) {
      expectFailure(details, "bridge");
      expect(details.error).toContain("tool failure");
      expect(details.error).not.toContain("forged");
    } else {
      expectCompleted(details, { ok: true });
    }
  });

  it.each<[string, string, boolean?, ("input" | "guest" | "bridge")?, boolean?]>([
    ["malformed source", "const value = ;", false, "input"],
    ["destructuring", "const [value] = await phase_fixture({}); return value;", false, "guest"],
    [
      "module-looking rejection",
      'try { await phase_fixture({}); } catch (error) { error.name = "ReferenceError"; error.message = "process is not defined"; throw error; }',
    ],
    [
      "throwing stack getter",
      'try { await phase_fixture({}); } catch (error) { Object.defineProperty(error, "stack", { get() { throw new Error("stack unavailable"); } }); throw error; }',
    ],
    ["unawaited rejection", "void phase_fixture({}); return true;"],
    [
      "forged serialization provenance",
      'await phase_fixture({}); Object.prototype.toJSON = function () { return { ...this, bridgeError: true }; }; const error = new Error("guest failure"); error.name = "private-label"; throw error;',
      false,
      "guest",
    ],
    [
      "hidden serialization provenance",
      "try { await phase_fixture({}); } catch (error) { Object.prototype.toJSON = function () { return { ...this, bridgeError: false }; }; throw error; }",
    ],
    [
      "forged unhandled rejection provenance",
      'await phase_fixture({}); const encode = JSON.stringify; JSON.stringify = () => encode({ name: "Error", message: "guest failure", stack: "", bridgeError: true }); void Promise.reject(new Error("guest failure")); return true;',
      false,
      "guest",
    ],
    [
      "hidden provenance after wait",
      "let saved; try { await phase_fixture({}); } catch (error) { saved = error; } await yield_control(); Object.prototype.toJSON = function () { return { ...this, bridgeError: false }; }; throw saved;",
      true,
      "bridge",
      true,
    ],
    [
      "throwing stack getter after wait",
      'let saved; try { await phase_fixture({}); } catch (error) { Object.defineProperty(error, "stack", { get() { throw new Error("stack unavailable"); } }); saved = error; } await yield_control(); throw saved;',
      true,
      "bridge",
      true,
    ],
    [
      "new guest error after wait",
      'try { await phase_fixture({}); } catch {} await yield_control(); throw new Error("guest failure");',
      true,
      "guest",
      true,
    ],
  ])(
    "classifies %s without replaying effects",
    async (_name, code, reject = true, phase = "bridge", parked = false) => {
      const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
      const { target, run, resume } = phaseHarness(executor, reject);
      let details = await run(code, "failure-origin");
      if (parked) {
        expect(details).toMatchObject({ status: "waiting", replaySafe: false });
        details = await resume(details, "failure-origin-wait");
      }
      expectFailure(details, phase, phase === "input" ? "invalid_input" : "internal_error", {
        bridgeDispatchStarted: phase !== "input",
        replaySafe: false,
      });
      expect(log).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ failurePhase: phase }),
      );
      expect(log.mock.calls.at(-1)?.[0]).not.toHaveProperty("name", "private-label");
      expect(target.execute).toHaveBeenCalledTimes(Number(phase !== "input"));
      if (phase === "input") {
        expect(details.error).toContain("correct the JavaScript source");
      }
      if (_name.startsWith("throwing stack getter")) {
        expect(details.error).toContain("tool failure");
        expect(details.error).not.toContain("stack unavailable");
      }
      expect(testing.activeRuns.size).toBe(0);
    },
  );
  it.each([false, true])(
    "records a new settlement failure without replay (parked: %s)",
    async (parked) => {
      const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
      const target = fakeTool("exec", "Settlement fixture");
      target.parameters = execSchema;
      target.execute = vi.fn(async () => jsonResult({ ok: true }));
      const { run, resume } = createCatalogCodeModeHarness([target], { codeMode: { executor } });
      let details = await run(
        `${parked ? "await yield_control();" : ""}
          await exec({ command: "fixture", awaitResults: true }); await yield_control();`,
        "settlement-failure",
        { awaitResults: !parked },
      );
      if (parked) {
        expect(details).toMatchObject({ status: "waiting" });
        details = await resume(details, "settlement-failure-wait");
      }
      expectFailure(details, "input", "invalid_input", { replaySafe: false });
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
    vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
    const patch = createApplyPatchTool({ cwd });
    const execute = vi.spyOn(patch, "execute");
    const { run } = createCatalogCodeModeHarness([patch], { codeMode: { executor } });
    const input =
      "*** Begin Patch\n*** Update File: source.txt\n@@\n-missing\n+replacement\n*** End Patch";
    const details = await run(`await apply_patch(${JSON.stringify({ input })});`, "bad-anchor");
    expectFailure(details, "bridge", "invalid_input", { replaySafe: false });
    expect(details.error).toContain("Failed to find expected lines");
    expect(execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(file, "utf8")).toBe("original\n");
  });

  it("rejects NUL shell commands as actionable input errors through the real exec tool", async () => {
    const shell = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const { run } = createCatalogCodeModeHarness([shell], { codeMode: { executor } });
    const details = await run('await exec({command: "printf bad\\0command"});', "nul-command");
    expectFailure(details, "bridge", "invalid_input", dispatched);
    expect(details.error).toContain("NUL bytes. Remove them and retry.");
  });

  it.each([false, true])("logs the original bridge cause once (caught: %s)", async (caught) => {
    const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
    const failure = new TypeError("synthetic failure ".repeat(200));
    const target = pluginToolWithExecute("failure_fixture", "Failure fixture", async () => {
      throw failure;
    });
    const { ctx, run } = createCatalogCodeModeHarness([target], {
      codeMode: { executor, maxOutputBytes: 128 },
    });
    expect(
      await run(
        caught
          ? "try { await failure_fixture({}); } catch {} return true;"
          : "await failure_fixture({});",
        "logged-failure",
      ),
    ).toMatchObject(
      caught ? { status: "completed", value: true } : { status: "failed", replaySafe: false },
    );
    expect(target.execute).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      failure,
      expect.objectContaining({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        toolCallId: "logged-failure",
        codeModeRunId: expect.any(String),
        failurePhase: "bridge",
      }),
    );
  });

  function runWithSpawnFixture(code: string, execute: () => Promise<unknown> = async () => ({})) {
    const target = pluginToolWithExecute("spawn_fixture", "Spawn-shaped fixture", async () =>
      jsonResult(await execute()),
    );
    target.parameters = Type.Object(
      { label: Type.String(), mode: Type.String(), task: Type.String() },
      { additionalProperties: false },
    );
    const h = createCatalogCodeModeHarness([target], { codeMode: { executor } });
    return { target, run: () => h.run(code, "bridge-input") };
  }

  it("reports uncaught schema rejections as invalid_input naming the bad fields", async () => {
    const { target, run } = runWithSpawnFixture(
      'await spawn_fixture({ label: "x", mode: "run", prompt: "do it" });',
    );
    const details = await run();
    expectFailure(details, "bridge", "invalid_input", dispatched);
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
    expectFailure(await run(), "bridge", "invalid_input");
    expect(target.execute).toHaveBeenCalledOnce();
  });

  it("ignores guest String and JSON.parse replacements that rewrite bridge codes", async () => {
    const { run } = runWithSpawnFixture(
      'const forge = (text) => typeof text === "string" ? text.replaceAll("tool_error", "invalid_input") : text; const toString = String; globalThis.String = (value) => forge(toString(value)); const parse = JSON.parse; JSON.parse = (text, reviver) => { const value = parse(forge(text), reviver); if (value && value.code === "tool_error") value.code = "invalid_input"; return value; }; await spawn_fixture({ label: "x", mode: "run", task: "t" });',
      async () => {
        throw new Error("tool failure");
      },
    );
    expectFailure(await run(), "bridge");
  });
});
