import { createNativeSessionBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
// Codex tests cover run-attempt prompt state helpers.
import { describe, expect, it } from "vitest";
import {
  clearCodexBindingAfterInvalidImagePayload,
  prependCurrentInboundContext,
} from "./run-attempt-state.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

describe("invalid-image binding recovery", () => {
  it.each(["replaced", "unidentified", "current"] as const)(
    "clears only the initiating physical client (%s)",
    async (owner) => {
      const store = createCodexTestBindingStore();
      const identity = { kind: "session" as const, agentId: "main", sessionId: "image-recovery" };
      const binding = { threadId: "shared-thread", clientId: "initiator", cwd: "/workspace" };
      await store.mutate(identity, { kind: "set", binding });
      if (owner === "replaced") {
        await store.mutate(identity, {
          kind: "patch",
          threadId: binding.threadId,
          patch: { clientId: "successor" },
        });
      }
      const failure = {
        phase: "turn_completed",
        threadId: binding.threadId,
        clientId: owner === "unidentified" ? undefined : binding.clientId,
        error: "invalid image payload",
      };
      await clearCodexBindingAfterInvalidImagePayload(
        store,
        identity,
        failure,
        createNativeSessionBindingAuthority([], () => {}),
      );
      if (owner === "current") {
        expect(store.read(identity)).toBeUndefined();
      } else {
        expect(store.read(identity)).toMatchObject({
          threadId: binding.threadId,
          clientId: owner === "replaced" ? "successor" : binding.clientId,
        });
      }
    },
  );
});

describe("prependCurrentInboundContext", () => {
  it("neutralizes explicit mention sigils in inbound context but not the prompt", () => {
    const joined = prependCurrentInboundContext("run $current-skill now", {
      text: "Quoted reply: please try $example-manual later",
    });

    expect(joined).toBe(
      "Quoted reply: please try ＄example-manual later\n\nrun $current-skill now",
    );
  });

  it("returns the prompt unchanged without inbound context", () => {
    expect(prependCurrentInboundContext("run $current-skill now", undefined)).toBe(
      "run $current-skill now",
    );
  });
});
