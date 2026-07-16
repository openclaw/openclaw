// Child-process proof uses OpenClaw's real fatal unhandled-rejection handler so
// a detached callback rejection would terminate the process.
import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

describe("embedded agent callback rejection containment", () => {
  it("keeps the production assistant progress path alive when its callback rejects", () => {
    const result = spawnNodeEvalSync(
      `import { installUnhandledRejectionHandler } from "./src/infra/unhandled-rejections.ts";
       import { subscribeEmbeddedAgentSession } from "./src/agents/embedded-agent-subscribe.ts";
       installUnhandledRejectionHandler();
       let emit = () => {};
       let callbackCalls = 0;
       const session = {
         subscribe(handler) {
           emit = handler;
           return () => {};
         },
       };
       subscribeEmbeddedAgentSession({
         session,
         runId: "fatal-handler-proof",
         onAgentEvent: async () => {
           callbackCalls += 1;
           throw new Error("assistant-progress-rejection");
         },
       });
       emit({
         type: "message_update",
         message: { role: "assistant" },
         assistantMessageEvent: { type: "text_delta", delta: "hello" },
       });
       await new Promise((resolve) => setImmediate(resolve));
       if (callbackCalls !== 1) {
         console.error("unexpected callback count: " + callbackCalls);
         process.exit(2);
       }
       console.log("assistant callback rejection contained");`,
      { imports: ["tsx"], timeout: 20_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("assistant callback rejection contained");
    expect(result.stderr).not.toContain("Unhandled promise rejection");
  });
});
