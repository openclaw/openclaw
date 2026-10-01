import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

describe.each(["node", "quickjs"] as const)("Code Mode %s failure origin", (executor) => {
  it.each([
    {
      name: "object destructuring after a successful tool",
      code: "const [value] = await phase_fixture({}); return value;",
      reject: false,
      phase: "guest",
      parked: false,
    },
    {
      name: "uncaught tool rejection",
      code: "await phase_fixture({});",
      reject: true,
      phase: "bridge",
      parked: false,
    },
    {
      name: "caught tool rejection followed by a new guest error",
      code: 'try { await phase_fixture({}); } catch {} throw new Error("guest failure");',
      reject: true,
      phase: "guest",
      parked: false,
    },
    {
      name: "guest replacement of WeakSet methods",
      code: 'WeakSet.prototype.add = () => { throw new Error("changed add"); }; WeakSet.prototype.has = () => false; await phase_fixture({});',
      reject: true,
      phase: "bridge",
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
      name: "rethrow of the original tool rejection",
      code: "try { await phase_fixture({}); } catch (error) { throw error; }",
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
      name: "guest error copying bridge-looking fields",
      code: 'await phase_fixture({}); throw Object.assign(new Error("tool failure"), { code: "tool_error", effectStatus: "unknown", bridgeError: true });',
      reject: false,
      phase: "guest",
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
      name: "original tool rejection retained across wait",
      code: "let saved; try { await phase_fixture({}); } catch (error) { saved = error; } await yield_control(); throw saved;",
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
    {
      name: "guest error after a successful tool and wait",
      code: 'await phase_fixture({}); await yield_control(); throw new Error("guest failure");',
      reject: false,
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
