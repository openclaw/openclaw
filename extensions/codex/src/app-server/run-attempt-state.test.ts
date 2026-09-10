// Codex tests cover run-attempt prompt state helpers.
import { describe, expect, it } from "vitest";
import {
  clearCodexBindingAfterInvalidImagePayload,
  prependCurrentInboundContext,
} from "./run-attempt-state.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

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

describe("clearCodexBindingAfterInvalidImagePayload", () => {
  it("preserves a newer physical client binding for the same native thread", async () => {
    const bindingStore = createCodexTestBindingStore();
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-shared", clientId: "client-old", cwd: "/repo" },
    });
    await bindingStore.mutate(identity, {
      kind: "patch",
      threadId: "thread-shared",
      patch: { clientId: "client-new" },
    });

    await clearCodexBindingAfterInvalidImagePayload(
      bindingStore,
      identity,
      {
        phase: "turn_completed",
        threadId: "thread-shared",
        clientId: "client-old",
        error: "invalid image payload",
      },
      () => {},
    );

    expect(bindingStore.read(identity)).toMatchObject({
      threadId: "thread-shared",
      clientId: "client-new",
    });
  });

  it("does not clear after the admitted attempt authority is revoked", async () => {
    const bindingStore = createCodexTestBindingStore();
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-current", clientId: "client-current", cwd: "/repo" },
    });

    await expect(
      clearCodexBindingAfterInvalidImagePayload(
        bindingStore,
        identity,
        {
          phase: "turn_completed",
          threadId: "thread-current",
          clientId: "client-current",
          error: "invalid image payload",
        },
        () => {
          throw new Error("attempt authority revoked");
        },
      ),
    ).rejects.toThrow("attempt authority revoked");
    expect(bindingStore.read(identity)).toMatchObject({
      threadId: "thread-current",
      clientId: "client-current",
    });
  });

  it("preserves the binding when the stale attempt has no physical client owner", async () => {
    const bindingStore = createCodexTestBindingStore();
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-shared", clientId: "client-new", cwd: "/repo" },
    });

    await clearCodexBindingAfterInvalidImagePayload(
      bindingStore,
      identity,
      {
        phase: "turn_completed",
        threadId: "thread-shared",
        error: "invalid image payload",
      },
      () => {},
    );

    expect(bindingStore.read(identity)).toMatchObject({
      threadId: "thread-shared",
      clientId: "client-new",
    });
  });
});
