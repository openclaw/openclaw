import { expect, it } from "vitest";
import { execNodeEvalSync } from "../../../test-utils/node-process.js";

it("releases disposed target inputs while a native context retains its transcript guard", () => {
  const output = execNodeEvalSync(
    `import assert from "node:assert/strict";
     import { AsyncLocalStorage } from "node:async_hooks";
     import { expectCollected } from ${JSON.stringify(new URL("../../../test-utils/retention.ts", import.meta.url).href)};
     import { createPreparedSessionTargetAssertion } from ${JSON.stringify(new URL("./attempt-session-target.ts", import.meta.url).href)};
     const carrier = new AsyncLocalStorage();
     const assertActiveRun = Object.assign(() => {}, { assertScopeCurrent() {} });
     class PromptState { sessionId = "synthetic"; sessionTarget = { sessionId: "synthetic" }; }
     const retained = await (async () => {
       const state = new PromptState();
       const scope = createPreparedSessionTargetAssertion({
         runId: "retained-target", sessionId: "synthetic", sessionPromptState: state,
         selectedPromptTarget: { sessionId: "synthetic" },
         isAttemptCurrent: () => true, assertActiveRun,
       });
       try {
         scope.assertCurrent();
         const context = carrier.run(scope.assertCurrent, () => AsyncLocalStorage.snapshot());
         return { context, check: scope.assertCurrent, state: new WeakRef(state) };
       } finally { scope[Symbol.dispose](); }
     })();
     await expectCollected(retained.state);
     assert.equal(retained.context(() => carrier.getStore()), retained.check);
     assert.throws(retained.check, /Session target preparation outlived its attempt/);
     console.log("Target data released; guard retained");`,
    { imports: ["./scripts/tsx.mjs"], execArgv: ["--expose-gc"], timeout: 20_000 },
  );
  expect(output).toContain("Target data released; guard retained");
});
