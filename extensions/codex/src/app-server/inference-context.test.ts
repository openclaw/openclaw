import { describe, expect, it } from "vitest";
import {
  CODEX_INFERENCE_GENERATION_KEY,
  createCodexInferenceContext,
} from "./inference-context.js";
import { readCodexInferenceMetadata } from "./inference-metadata.js";
import type { JsonObject } from "./protocol.js";

function request(
  threadId: string,
  generation?: string,
  extra: JsonObject = {},
  flat: JsonObject = {},
): JsonObject {
  return {
    instructions: "native base",
    input: [{ role: "developer", content: "native catalog collaboration" }],
    client_metadata: {
      thread_id: threadId,
      ...flat,
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        request_kind: "turn",
        ...(generation ? { [CODEX_INFERENCE_GENERATION_KEY]: generation } : {}),
        ...extra,
      }),
    },
  };
}

function fixture(assertCurrent = () => {}) {
  const context = createCodexInferenceContext(() => {});
  const controller = new AbortController();
  const register = (text: string) =>
    context.register({ threadId: "root", text, signal: controller.signal, assertCurrent });
  return { context, controller, register };
}

describe("native inference metadata", () => {
  it("reconciles native body and HTTP metadata and rejects conflicting attribution", () => {
    const nested = {
      session_id: "session",
      thread_id: "child",
      turn_id: "turn",
      parent_thread_id: "parent",
      parent_turn_id: "parent-turn",
      root_turn_id: "root-turn",
      request_kind: "turn",
      thread_source: "subagent",
      subagent_kind: "thread_spawn",
      auto_review_enabled: true,
      node_repl_auto_review_required: false,
      [CODEX_INFERENCE_GENERATION_KEY]: "generation",
    };
    const flat = {
      session_id: "session",
      turn_id: "turn",
      parent_turn_id: "parent-turn",
      root_turn_id: "root-turn",
      "x-codex-parent-thread-id": "parent",
      "x-openai-subagent": "collab_spawn",
    };
    const source = request("child", "generation", nested, flat);
    const headers = {
      "session-id": "session",
      "thread-id": "child",
      "x-codex-parent-thread-id": "parent",
      "x-openai-subagent": "collab_spawn",
      "x-codex-turn-metadata": JSON.stringify(nested),
    };
    expect(readCodexInferenceMetadata(source, headers)).toMatchObject({
      sessionId: "session",
      threadId: "child",
      turnId: "turn",
      parentThreadId: "parent",
      parentTurnId: "parent-turn",
      rootTurnId: "root-turn",
      requestKind: "turn",
      threadSource: "subagent",
      subagent: "collab_spawn",
      subagentKind: "thread_spawn",
      autoReviewEnabled: true,
      nodeReplAutoReviewRequired: false,
      generation: "generation",
    });
    for (const key of ["thread-id", "x-codex-parent-thread-id", "x-openai-subagent"]) {
      expect(() => readCodexInferenceMetadata(source, { ...headers, [key]: "other" })).toThrow(
        "metadata disagrees",
      );
    }
    for (const key of ["session_id", "turn_id", "parent_turn_id", "root_turn_id"]) {
      expect(() =>
        readCodexInferenceMetadata(
          request("child", "generation", nested, { ...flat, [key]: "other" }),
        ),
      ).toThrow("metadata disagrees");
    }
    expect(() =>
      readCodexInferenceMetadata(source, {
        ...headers,
        "x-codex-turn-metadata": JSON.stringify({ ...nested, auto_review_enabled: false }),
      }),
    ).toThrow("metadata disagrees");
  });

  it("uses current WS frame identities and checks only the session-stable handshake source", () => {
    const source = request("current-thread", "current-generation", {
      session_id: "current-session",
      turn_id: "current-turn",
      parent_thread_id: "current-parent",
      parent_turn_id: "current-parent-turn",
      root_turn_id: "current-root-turn",
    });
    const headers = {
      "session-id": "previous-session",
      "thread-id": "previous-thread",
      "x-codex-parent-thread-id": "previous-parent",
      "x-openai-subagent": "guardian",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "previous-thread",
        turn_id: "previous-turn",
        parent_turn_id: "previous-parent-turn",
        root_turn_id: "previous-root-turn",
        [CODEX_INFERENCE_GENERATION_KEY]: "previous-generation",
      }),
    };
    expect(readCodexInferenceMetadata(source, headers, "websocket")).toMatchObject({
      sessionId: "current-session",
      threadId: "current-thread",
      turnId: "current-turn",
      parentThreadId: "current-parent",
      parentTurnId: "current-parent-turn",
      rootTurnId: "current-root-turn",
      generation: "current-generation",
      subagent: "guardian",
    });
    expect(() => readCodexInferenceMetadata(source, headers, "http")).toThrow("metadata disagrees");
    expect(() =>
      readCodexInferenceMetadata(
        request("current-thread", undefined, {}, { "x-openai-subagent": "review" }),
        headers,
        "websocket",
      ),
    ).toThrow("subagent metadata disagrees");
  });
});

describe("parent-local inference context", () => {
  it("forks the retained prepared prefix after parent cleanup under only the new root's authority", () => {
    let parentActive = true;
    const { context, controller, register } = fixture(() => {
      if (!parentActive) {
        throw new Error("parent authority ended");
      }
    });
    const parent = register("private persona\n\nskills\n\nmemory");
    const expectedInstructions = context.prepare(request("root", parent.generation)).body
      .instructions;
    parent.release();
    controller.abort();
    parentActive = false;
    expect(() => context.prepare(request("root", parent.generation))).toThrow("current admitted");
    let forkActive = true;
    const forkController = new AbortController();
    const fork = context.fork({
      sourceThreadId: "root",
      threadId: "fork",
      signal: forkController.signal,
      assertCurrent: () => {
        if (!forkActive) {
          throw new Error("fork authority ended");
        }
      },
    });
    const source = request("fork", fork.generation);
    const prepared = context.prepare(source);
    expect(prepared.body.instructions).toBe(expectedInstructions);
    parent.release();
    expect(context.prepare(source).body.instructions).toBe(expectedInstructions);
    expect(() => context.prepare(request("fork", parent.generation))).toThrow("current admitted");
    expect(() =>
      context.fork({
        sourceThreadId: "missing",
        threadId: "another",
        signal: forkController.signal,
        assertCurrent: () => {},
      }),
    ).toThrow("prepared parent");
    context.forget("root");
    expect(() =>
      context.fork({
        sourceThreadId: "root",
        threadId: "later",
        signal: forkController.signal,
        assertCurrent: () => {},
      }),
    ).toThrow("prepared parent");
    expect(context.prepare(source).body.instructions).toBe(expectedInstructions);
    forkActive = false;
    expect(() => context.prepare(source)).toThrow("fork authority ended");
    forkActive = true;
    forkController.abort();
    expect(() => prepared.assertCurrent()).toThrow();
    expect(() => context.prepare(source)).toThrow("current admitted");
    context.close();
  });

  it.each([false, true])(
    "keeps the complete native suffix when reconstructed prefix changes=%s",
    (changed) => {
      const { context, register } = fixture();
      const parent = register("private");
      const input = [
        { role: "developer", content: "parent environment" },
        { role: "user", content: "parent question" },
      ];
      const expected = context.prepare({ ...request("root", parent.generation), input }).body;
      parent.release();
      const fork = context.fork({
        sourceThreadId: "root",
        threadId: "fork",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const tail: JsonObject[] = [
        { role: "assistant", content: "Parent final answer 4837" },
        { role: "user", content: "Review that answer" },
        { type: "function_call", call_id: "denied", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "denied", output: "Tool execution denied" },
      ];
      const rebuilt = changed
        ? [{ role: "developer", content: "rebuilt environment" }, ...input.slice(1)]
        : input;
      try {
        const prepared = context.prepare({
          ...request("fork", fork.generation),
          instructions: "rebuilt base",
          input: [...rebuilt, ...tail],
        }).body;
        expect(prepared.input).toEqual([...rebuilt, ...tail]);
        expect(prepared.instructions).toBe(expected.instructions);
        expect(prepared.tool_choice).toBe("none");
      } finally {
        context.close();
      }
    },
  );

  it.each([undefined, ""])(
    "preserves recorded instructions=%j when native history is rebuilt",
    (instructions) => {
      const { context, register } = fixture();
      const parent = register("");
      const source = request("root", parent.generation);
      delete source.instructions;
      if (instructions !== undefined) {
        source.instructions = instructions;
      }
      context.prepare(source);
      parent.release();
      const fork = context.fork({
        sourceThreadId: "root",
        threadId: "fork",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const input = [
        { role: "developer", content: "rebuilt environment" },
        { role: "assistant", content: "completed parent answer" },
        { role: "user", content: "side question" },
      ];
      try {
        const prepared = context.prepare({
          ...request("fork", fork.generation),
          instructions: "rebuilt base",
          input,
        }).body;
        expect(prepared.input).toEqual(input);
        expect(prepared.instructions).toBe(instructions);
        expect(Object.hasOwn(prepared, "instructions")).toBe(instructions !== undefined);
      } finally {
        context.close();
      }
    },
  );

  it("preserves parent tool declarations but uses native history after a WebSocket continuation", () => {
    const { context, register } = fixture();
    const parent = register("private");
    const declarations = {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "custom", name: "exec", description: "exact catalog including web.run" }],
    };
    context.prepare({
      ...request("root", parent.generation),
      input: [declarations, { role: "user", content: "parent task" }],
    });
    context.prepare({
      ...request("root", parent.generation),
      previous_response_id: "parent-response",
      input: [{ type: "function_call_output", call_id: "call", output: "one" }],
    });
    parent.release();
    const fork = context.fork({
      sourceThreadId: "root",
      threadId: "fork",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const history = [
      { role: "user", content: "native reconstructed parent task" },
      { role: "assistant", content: "native reconstructed answer" },
      { role: "user", content: "side question" },
    ];
    try {
      const prepared = context.prepare({
        ...request("fork", fork.generation),
        input: [{ ...declarations, tools: [] }, ...history],
      }).body;
      expect(prepared.input).toEqual([declarations, ...history]);
      expect(prepared.tool_choice).toBe("none");
      expect(prepared).not.toHaveProperty("previous_response_id");
    } finally {
      context.close();
    }
  });
  it.each([
    { input: [] },
    { input: [{ type: "function_call_output", call_id: "call", output: "result" }] },
  ])(
    "uses native reconstruction rather than treating a continuation delta as full input: %j",
    ({ input }) => {
      const { context, register } = fixture();
      const parent = register("private");
      context.prepare(request("root", parent.generation));
      context.prepare({
        ...request("root", parent.generation),
        previous_response_id: "previous-response",
        input,
      });
      parent.release();
      const fork = context.fork({
        sourceThreadId: "root",
        threadId: "fork",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const rebuilt = {
        ...request("fork", fork.generation),
        instructions: "rebuilt base",
        input: [
          { role: "user", content: "full native parent task" },
          { role: "assistant", content: "full native parent answer" },
          { role: "user", content: "side question" },
        ],
      };
      try {
        expect(context.prepare(rebuilt).body).toEqual({
          ...rebuilt,
          instructions: "native base\n\nprivate",
          tool_choice: "none",
        });
      } finally {
        context.close();
      }
    },
  );

  it("falls back to native reconstruction when the global wire-prefix LRU evicts a session", () => {
    const contexts = Array.from({ length: 3 }, () => createCodexInferenceContext(() => {}));
    const contextAt = (index: number) => {
      const context = contexts[index];
      if (!context) {
        throw new Error(`Missing inference context ${index}`);
      }
      return context;
    };
    const payload = "x".repeat(11 * 1024 * 1024);
    const prepareParent = (index: number) => {
      const context = contextAt(index);
      const parent = context.register({
        threadId: "parent",
        text: "private",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      context.prepare({
        ...request("parent", parent.generation),
        input: [{ role: "user", content: payload }],
      });
      parent.release();
    };
    const fork = (index: number) =>
      contextAt(index).fork({
        sourceThreadId: "parent",
        threadId: "fork",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
    try {
      prepareParent(0);
      prepareParent(1);
      fork(0).release();
      prepareParent(2);
      for (const index of [0, 1, 2]) {
        const child = fork(index);
        const rebuilt = {
          ...request("fork", child.generation),
          instructions: "rebuilt",
          input: [
            { role: "user", content: payload },
            { role: "user", content: "side question" },
          ],
        };
        const prepared = contextAt(index).prepare(rebuilt).body;
        expect(prepared.instructions).toBe(
          index === 1 ? "rebuilt\n\nprivate" : "native base\n\nprivate",
        );
        expect(prepared.input).toHaveLength(2);
        child.release();
      }
    } finally {
      for (const context of contexts) {
        context.close();
      }
    }
  });

  it("rejects explicit non-string instructions", () => {
    const { context, register } = fixture();
    expect(() =>
      context.prepare({ ...request("root", register("persona").generation), instructions: null }),
    ).toThrow("instructions");
    context.close();
  });

  it("refreshes and removes parent instructions without rewriting native history or affecting children", () => {
    const { context, register } = fixture();
    const first = register("persona A");
    const source = request("root", first.generation);
    const original = structuredClone(source);
    const prepared = context.prepare(source);
    expect(prepared.body).toEqual({ ...source, instructions: "native base\n\npersona A" });
    expect(source).toEqual(original);
    const second = register("persona B");
    first.release();
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => prepared.assertCurrent()).toThrow();
    expect(() => context.prepare(source)).toThrow("current admitted");
    expect(context.prepare(request("root", second.generation)).body.instructions).toBe(
      "native base\n\npersona B",
    );
    const child = request("child", second.generation, {
      parent_thread_id: "root",
      subagent_kind: "collab_spawn",
    });
    expect(context.prepare(child).body).toEqual(child);
    const removed = register("");
    const after = request("root", removed.generation);
    expect(context.prepare(after).body).toEqual(after);
    context.close();
    expect(() => context.prepare(after)).toThrow("closed");
  });

  it("requires exact physical owner, root identity and admitted generation", () => {
    let active = true;
    const { context, register } = fixture(() => {
      if (!active) {
        throw new Error("owner retired");
      }
    });
    const registration = register("private");
    const source = request("root", registration.generation);
    const prepared = context.prepare(source);
    expect(() => context.prepare(request("other", registration.generation))).toThrow(
      "current admitted",
    );
    expect(() => createCodexInferenceContext(() => {}).prepare(source)).toThrow("current admitted");
    expect(() => context.prepare(request("root"))).toThrow("current admitted");
    expect(() =>
      context.prepare({
        ...source,
        client_metadata: {
          thread_id: "root",
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "turn",
            [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
          }),
        },
      }),
    ).toThrow("native thread metadata");
    expect(() =>
      context.prepare({
        ...source,
        client_metadata: {
          thread_id: "conflicting-root",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "root",
            request_kind: "turn",
            [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
          }),
        },
      }),
    ).toThrow("metadata disagrees");
    active = false;
    expect(() => prepared.assertCurrent()).toThrow("owner retired");
    expect(() => context.prepare(source)).toThrow("owner retired");
    context.close();
  });

  it("does not contaminate local compaction, memory, review or unadmitted startup prewarm", () => {
    const { context, register } = fixture();
    const registration = register("persona B");
    const exclusions: JsonObject[] = [
      { request_kind: "compaction" },
      { request_kind: "memory" },
      { subagent_kind: "review" },
    ];
    for (const extra of exclusions) {
      const source = request("root", registration.generation, extra);
      expect(context.prepare(source).body).toEqual(source);
    }
    // Native Memory metadata intentionally omits its nested thread identity while
    // client_metadata still carries the physical thread ID.
    const memory = {
      instructions: "native memory instructions",
      input: [],
      client_metadata: {
        thread_id: "memory-thread",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }),
      },
    };
    expect(context.prepare(memory).body).toEqual(memory);
    expect(readCodexInferenceMetadata(memory)).toMatchObject({
      threadId: "memory-thread",
      requestKind: "memory",
    });
    const classifier = {
      instructions: "native classifier instructions",
      input: [],
      client_metadata: {
        session_id: "session",
        thread_id: "classifier-connection",
        turn_id: "classification-turn",
        parent_turn_id: "parent-turn",
        "x-openai-subagent": "guardian",
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "session",
          thread_id: "classifier-connection",
          turn_id: "classification-turn",
          parent_turn_id: "parent-turn",
          root_turn_id: "root-turn",
          guardian_classifier_source_thread_id: "root",
          thread_source: "guardian_classifier",
        }),
      },
    };
    const classifierMetadata = readCodexInferenceMetadata(classifier);
    expect(classifierMetadata).toMatchObject({
      threadId: "classifier-connection",
      parentTurnId: "parent-turn",
      rootTurnId: "root-turn",
      guardianClassifierSourceThreadId: "root",
      subagent: "guardian",
    });
    expect(classifierMetadata.requestKind).toBeUndefined();
    expect(context.prepare(classifier, classifierMetadata).body).toBe(classifier);
    const rootWithClassifierHint = request("root", registration.generation, {
      guardian_classifier_source_thread_id: "root",
    });
    expect(context.prepare(rootWithClassifierHint).body.instructions).toContain("persona B");
    const startup = { ...request("root", undefined, { request_kind: "prewarm" }), generate: false };
    expect(context.prepare(startup).body).toEqual(startup);
    // Immediate normal continuation after compaction still reads the current snapshot.
    expect(context.prepare(request("root", registration.generation)).body.instructions).toContain(
      "persona B",
    );
    context.close();
  });

  it("bounds retained prefixes independently of completed turn registrations", () => {
    const { context, controller } = fixture();
    const register = (threadId: string) =>
      context.register({
        threadId,
        text: "prepared",
        signal: controller.signal,
        assertCurrent: () => {},
      });
    for (let index = 0; index < 256; index += 1) {
      register(`thread-${index}`).release();
    }
    expect(() => register("overflow")).toThrow("prepared inference prefix limit");
    context.forget("thread-0");
    const replacement = register("replacement");
    replacement.release();
    const fork = context.fork({
      sourceThreadId: "replacement",
      threadId: "side",
      signal: controller.signal,
      assertCurrent: () => {},
    });
    expect(context.prepare(request("side", fork.generation)).body.instructions).toBe(
      "native base\n\nprepared",
    );
    context.close();
    expect(() =>
      context.fork({
        sourceThreadId: "replacement",
        threadId: "after-close",
        signal: controller.signal,
        assertCurrent: () => {},
      }),
    ).toThrow("closed");
  });

  it("bounds context and fences aborts, missing metadata and unsupported request kinds", () => {
    const { context, controller, register } = fixture();
    expect(() => register("x".repeat(256 * 1024 + 1))).toThrow("limit");
    const registered = register("private");
    const source = request("root", registered.generation);
    expect(() => context.prepare({ instructions: "base" })).toThrow("metadata");
    const invalidMetadata: JsonObject[] = [
      { thread_id: "x".repeat(257) },
      { auto_review_enabled: "true" },
    ];
    for (const extra of invalidMetadata) {
      expect(() => context.prepare(request("root", registered.generation, extra))).toThrow(
        "metadata",
      );
    }
    expect(() =>
      context.prepare({
        client_metadata: { "x-codex-turn-metadata": "x".repeat(1024 * 1024 + 1) },
      }),
    ).toThrow("bounded native metadata");
    expect(() =>
      context.prepare(request("root", registered.generation, { request_kind: "other" })),
    ).toThrow("purpose");
    const prepared = context.prepare(source);
    controller.abort();
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => context.prepare(source)).toThrow("current admitted");
    context.close();
  });
});
