import { AsyncLocalStorage } from "node:async_hooks";
import "./browser-tool.test-support.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
import { getBrowserRequestScope } from "./browser/request-scope.js";

const { browserActionsMocks: actions, resetBrowserToolMocks } =
  await import("./browser-tool.test-support.js");

beforeEach(resetBrowserToolMocks);
afterEach(resetBrowserToolMocks);

// Mirrors the host guards: each context-level check resolves its caller when it runs.
type Call = { name: string; current: boolean };
const calls = new AsyncLocalStorage<Call>();
const checked: string[] = [];
function assertInvocationCurrent() {
  const call = calls.getStore();
  checked.push(call?.name ?? "none");
  if (call && !call.current) {
    throw new Error("tool invocation authority is no longer active");
  }
}

it("checks request authority against the invoking call from another call's event context", async () => {
  checked.length = 0;
  const tool = createBrowserTool({
    assertInvocationCurrent,
    assertLocalLoopbackCurrent: assertInvocationCurrent,
  });
  // A shared connection created during an earlier call delivers events in that call's context.
  const earlier: Call = { name: "earlier", current: true };
  const deliverEvent = calls.run(earlier, () => AsyncLocalStorage.snapshot());
  const invoking: Call = { name: "invoking", current: true };
  const outcomes: string[] = [];
  actions.browserNavigate.mockImplementationOnce(async () => {
    const scope = getBrowserRequestScope();
    const guards = [scope?.assertInvocationCurrent, scope?.assertLocalLoopbackCurrent];
    expect(guards.every((guard) => typeof guard === "function")).toBe(true);
    const check = () => {
      for (const guard of guards) {
        try {
          deliverEvent(() => guard?.());
          outcomes.push("allowed");
        } catch (error) {
          outcomes.push(error instanceof Error ? error.message : String(error));
        }
      }
    };
    // Ended earlier caller, current invoking caller: allowed.
    earlier.current = false;
    check();
    // Current earlier caller, ended invoking caller: refused, never borrowed.
    earlier.current = true;
    invoking.current = false;
    check();
    invoking.current = true;
    return { ok: true, targetId: "t1", url: "https://example.com/" };
  });

  await calls.run(invoking, () =>
    tool.execute("navigate", { action: "navigate", url: "https://example.com/" }),
  );

  const refused = "tool invocation authority is no longer active";
  expect(outcomes).toEqual(["allowed", "allowed", refused, refused]);
  expect(checked).not.toContain("earlier");
});
