// The production subscriber call sites are covered in block-reply-rejections;
// this child-process proof adds the real fatal unhandled-rejection handler.
import { describe, expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath, spawnNodeEvalSync } from "../test-utils/node-process.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

describe("embedded agent callback rejection containment", () => {
  it("keeps best-effort callbacks alive when their promises reject", () => {
    const callbackUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.callback);
    const result = spawnNodeEvalSync(
      `import { installUnhandledRejectionHandler } from ${JSON.stringify(resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.unhandledRejections).href)};
       import { runBestEffortCallback } from ${JSON.stringify(callbackUrl.href)};
       installUnhandledRejectionHandler();
       let callbackCalls = 0;
       const warnings = [];
       runBestEffortCallback({
         label: "assistant agent event",
         log: { warn: (message) => warnings.push(message) },
         callback: async () => {
           callbackCalls += 1;
           throw new Error("assistant-progress-rejection");
         },
       });
       await new Promise((resolve) => setImmediate(resolve));
       if (callbackCalls !== 1) {
         console.error("unexpected callback count: " + callbackCalls);
         process.exit(2);
       }
       if (!warnings.some((message) => message.includes("assistant-progress-rejection"))) {
         console.error("callback rejection was not logged");
         process.exit(3);
       }
       console.log("assistant callback rejection contained");`,
      {
        imports: resolveRuntimeWorkerArgv(callbackUrl, resolveTestNodeExecPath()).slice(1, -1),
        timeout: 20_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("assistant callback rejection contained");
    expect(result.stderr).not.toContain("Unhandled promise rejection");
  });
});
