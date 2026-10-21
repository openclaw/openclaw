import { describe, expect, it, onTestFinished } from "vitest";
import {
  CODEX_INFERENCE_GENERATION_KEY,
  createCodexInferenceContext,
} from "./inference-context.js";
import { readCodexInferenceMetadata } from "./inference-metadata.js";
import type { JsonObject } from "./protocol.js";

function wire(nested: JsonObject, flat: JsonObject = {}, body: JsonObject = {}): JsonObject {
  return {
    instructions: "native base",
    input: [{ role: "developer", content: "native catalog collaboration" }],
    ...body,
    client_metadata: { ...flat, "x-codex-turn-metadata": JSON.stringify(nested) },
  };
}

function request(
  threadId: string,
  generation?: string,
  extra: JsonObject = {},
  flat: JsonObject = {},
): JsonObject {
  return wire(
    {
      thread_id: threadId,
      request_kind: "turn",
      ...(generation ? { [CODEX_INFERENCE_GENERATION_KEY]: generation } : {}),
      ...extra,
    },
    { thread_id: threadId, ...flat },
  );
}

function fixture(assertCurrent = () => {}) {
  const context = createCodexInferenceContext(() => {});
  onTestFinished(() => context.close());
  const controller = new AbortController();
  const register = (text: string, threadId = "root") =>
    context.register({ threadId, text, signal: controller.signal, assertCurrent });
  const prepare = context.prepare.bind(context);
  const rejects = (body: JsonObject, message: string) =>
    expect(() => prepare(body)).toThrow(message);
  return { context, controller, register, prepare, rejects };
}

function forkContext(
  context: ReturnType<typeof createCodexInferenceContext>,
  overrides: Partial<Parameters<typeof context.fork>[0]> = {},
) {
  return context.fork({
    sourceThreadId: "root",
    threadId: "fork",
    signal: new AbortController().signal,
    assertCurrent: () => {},
    ...overrides,
  });
}

const identity = {
  session_id: "session",
  thread_id: "child",
  turn_id: "turn",
  parent_thread_id: "parent",
  parent_turn_id: "parent-turn",
  root_turn_id: "root-turn",
};
const expectedIdentity = {
  sessionId: "session",
  threadId: "child",
  turnId: "turn",
  parentThreadId: "parent",
  parentTurnId: "parent-turn",
  rootTurnId: "root-turn",
};
const rejectsMetadata = (...args: Parameters<typeof readCodexInferenceMetadata>) =>
  expect(() => readCodexInferenceMetadata(...args)).toThrow("metadata disagrees");

describe("native inference context", () => {
  it("reconciles native body and HTTP metadata and rejects conflicting attribution", () => {
    const nested = {
      ...identity,
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
      ...expectedIdentity,
      requestKind: "turn",
      threadSource: "subagent",
      subagent: "collab_spawn",
      subagentKind: "thread_spawn",
      autoReviewEnabled: true,
      nodeReplAutoReviewRequired: false,
      generation: "generation",
    });
    for (const key of ["thread-id", "x-codex-parent-thread-id", "x-openai-subagent"]) {
      rejectsMetadata(source, { ...headers, [key]: "other" });
    }
    for (const key of ["session_id", "turn_id", "parent_turn_id", "root_turn_id"]) {
      rejectsMetadata(request("child", "generation", nested, { ...flat, [key]: "other" }));
    }
    rejectsMetadata(source, {
      ...headers,
      "x-codex-turn-metadata": JSON.stringify({ ...nested, auto_review_enabled: false }),
    });
  });

  it("uses current WS frame identities and checks only the session-stable handshake source", () => {
    const source = request("child", "current-generation", identity);
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
      ...expectedIdentity,
      generation: "current-generation",
      subagent: "guardian",
    });
    rejectsMetadata(source, headers, "http");
    expect(() =>
      readCodexInferenceMetadata(
        request("current-thread", undefined, {}, { "x-openai-subagent": "review" }),
        headers,
        "websocket",
      ),
    ).toThrow("subagent metadata disagrees");
  });
  it("forks the retained prepared prefix after parent cleanup under only the new root's authority", () => {
    const parentAuthority = new AbortController();
    const { context, controller, register, prepare, rejects } = fixture(() =>
      parentAuthority.signal.throwIfAborted(),
    );
    const parent = register("private persona\n\nskills\n\nmemory");
    const expectedInstructions = prepare(request("root", parent.generation)).body.instructions;
    parent.release();
    controller.abort();
    parentAuthority.abort(new Error("parent authority ended"));
    rejects(request("root", parent.generation), "current admitted");
    let forkActive = true;
    const forkController = new AbortController();
    const fork = forkContext(context, {
      signal: forkController.signal,
      assertCurrent: () => {
        if (!forkActive) {
          throw new Error("fork authority ended");
        }
      },
    });
    const source = request("fork", fork.generation);
    const prepared = prepare(source);
    expect(prepared.body.instructions).toBe(expectedInstructions);
    parent.release();
    expect(prepare(source).body.instructions).toBe(expectedInstructions);
    rejects(request("fork", parent.generation), "current admitted");
    expect(() => forkContext(context, { sourceThreadId: "missing", threadId: "another" })).toThrow(
      "prepared parent",
    );
    context.forget("root");
    expect(() => forkContext(context, { threadId: "later" })).toThrow("prepared parent");
    expect(prepare(source).body.instructions).toBe(expectedInstructions);
    forkActive = false;
    rejects(source, "fork authority ended");
    forkActive = true;
    forkController.abort();
    expect(() => prepared.assertCurrent()).toThrow();
    rejects(source, "current admitted");
  });

  it("preserves parent tool declarations but uses native history after a WebSocket continuation", () => {
    const { context, register, prepare } = fixture();
    const parent = register("private");
    const declarations = {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "custom", name: "exec", description: "exact catalog including web.run" }],
    };
    prepare({
      ...request("root", parent.generation),
      input: [declarations, { role: "user", content: "parent task" }],
    });
    prepare({
      ...request("root", parent.generation),
      previous_response_id: "parent-response",
      input: [{ type: "function_call_output", call_id: "call", output: "one" }],
    });
    parent.release();
    const fork = forkContext(context);
    const history = [
      { role: "user", content: "native reconstructed parent task" },
      { role: "assistant", content: "native reconstructed answer" },
      { role: "user", content: "side question" },
    ];
    const prepared = prepare({
      ...request("fork", fork.generation),
      input: [{ ...declarations, tools: [] }, ...history],
    }).body;
    expect(prepared.input).toEqual([declarations, ...history]);
    expect(prepared.tool_choice).toBe("none");
    expect(prepared).not.toHaveProperty("previous_response_id");
  });

  it("falls back to native reconstruction when the global wire-prefix LRU evicts a session", () => {
    const contexts = [fixture(), fixture(), fixture()] as const;
    const payload = "x".repeat(11 * 1024 * 1024);
    const prepareParent = (index: 0 | 1 | 2) => {
      const { register, prepare } = contexts[index];
      const parent = register("private", "parent");
      prepare({
        ...request("parent", parent.generation),
        input: [{ role: "user", content: payload }],
      });
      parent.release();
    };
    const fork = (index: 0 | 1 | 2) =>
      forkContext(contexts[index].context, { sourceThreadId: "parent" });
    prepareParent(0);
    prepareParent(1);
    fork(0).release();
    prepareParent(2);
    for (const index of [0, 1, 2] as const) {
      const child = fork(index);
      const rebuilt = {
        ...request("fork", child.generation),
        instructions: "rebuilt",
        input: [
          { role: "user", content: payload },
          { role: "user", content: "side question" },
        ],
      };
      const prepared = contexts[index].prepare(rebuilt).body;
      expect(prepared.instructions).toBe(
        index === 1 ? "rebuilt\n\nprivate" : "native base\n\nprivate",
      );
      expect(prepared.input).toHaveLength(2);
      child.release();
    }
  });

  it("refreshes and removes parent instructions without rewriting native history or affecting children", () => {
    const { context, register, prepare, rejects } = fixture();
    const first = register("persona A");
    const source = request("root", first.generation);
    const original = structuredClone(source);
    const prepared = prepare(source);
    expect(prepared.body).toEqual({ ...source, instructions: "native base\n\npersona A" });
    expect(source).toEqual(original);
    const second = register("persona B");
    first.release();
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => prepared.assertCurrent()).toThrow();
    rejects(source, "current admitted");
    expect(prepare(request("root", second.generation)).body.instructions).toBe(
      "native base\n\npersona B",
    );
    const child = request("child", second.generation, {
      parent_thread_id: "root",
      subagent_kind: "collab_spawn",
    });
    expect(prepare(child).body).toEqual(child);
    const removed = register("");
    const after = request("root", removed.generation);
    expect(prepare(after).body).toEqual(after);
    context.close();
    rejects(after, "closed");
  });

  it("requires exact physical owner, root identity and admitted generation", () => {
    const authority = new AbortController();
    const { register, prepare, rejects } = fixture(() => authority.signal.throwIfAborted());
    const registration = register("private");
    const source = request("root", registration.generation);
    const prepared = prepare(source);
    rejects(request("other", registration.generation), "current admitted");
    expect(() => createCodexInferenceContext(() => {}).prepare(source)).toThrow("current admitted");
    rejects(request("root"), "current admitted");
    rejects(
      wire(
        { request_kind: "turn", [CODEX_INFERENCE_GENERATION_KEY]: registration.generation },
        { thread_id: "root" },
      ),
      "native thread metadata",
    );
    rejects(
      request("root", registration.generation, {}, { thread_id: "conflicting-root" }),
      "metadata disagrees",
    );
    authority.abort(new Error("owner retired"));
    expect(() => prepared.assertCurrent()).toThrow("owner retired");
    rejects(source, "owner retired");
  });

  it("does not contaminate local compaction, memory, review or unadmitted startup prewarm", () => {
    const { prepare, register } = fixture();
    const registration = register("persona B");
    const exclusions: JsonObject[] = [
      { request_kind: "compaction" },
      { request_kind: "memory" },
      { subagent_kind: "review" },
    ];
    for (const extra of exclusions) {
      const source = request("root", registration.generation, extra);
      expect(prepare(source).body).toEqual(source);
    }
    const memory = wire(
      { request_kind: "memory" },
      { thread_id: "memory-thread" },
      { instructions: "native memory instructions", input: [] },
    );
    expect(prepare(memory).body).toEqual(memory);
    expect(readCodexInferenceMetadata(memory)).toMatchObject({
      threadId: "memory-thread",
      requestKind: "memory",
    });
    const classifierIdentity = {
      thread_id: "classifier-connection",
      parent_turn_id: "parent-turn",
    };
    const classifier = wire(
      {
        ...classifierIdentity,
        root_turn_id: "root-turn",
        guardian_classifier_source_thread_id: "root",
        thread_source: "guardian_classifier",
      },
      { ...classifierIdentity, "x-openai-subagent": "guardian" },
      { instructions: "native classifier instructions", input: [] },
    );
    const classifierMetadata = readCodexInferenceMetadata(classifier);
    expect(classifierMetadata).toMatchObject({
      threadId: "classifier-connection",
      parentTurnId: "parent-turn",
      rootTurnId: "root-turn",
      guardianClassifierSourceThreadId: "root",
      subagent: "guardian",
    });
    expect(classifierMetadata.requestKind).toBeUndefined();
    expect(prepare(classifier, classifierMetadata).body).toBe(classifier);
    const rootWithClassifierHint = request("root", registration.generation, {
      guardian_classifier_source_thread_id: "root",
    });
    expect(prepare(rootWithClassifierHint).body.instructions).toContain("persona B");
    const startup = { ...request("root", undefined, { request_kind: "prewarm" }), generate: false };
    expect(prepare(startup).body).toEqual(startup);
    expect(prepare(request("root", registration.generation)).body.instructions).toContain(
      "persona B",
    );
  });

  it("bounds retained prefixes independently of completed turn registrations", () => {
    const { context, controller, register: registerRoot } = fixture();
    const register = (threadId: string) => registerRoot("prepared", threadId);
    for (let index = 0; index < 256; index += 1) {
      register(`thread-${index}`).release();
    }
    expect(() => register("overflow")).toThrow("prepared inference prefix limit");
    context.forget("thread-0");
    const replacement = register("replacement");
    replacement.release();
    const fork = forkContext(context, {
      sourceThreadId: "replacement",
      threadId: "side",
      signal: controller.signal,
    });
    expect(context.prepare(request("side", fork.generation)).body.instructions).toBe(
      "native base\n\nprepared",
    );
    context.close();
    expect(() =>
      forkContext(context, { sourceThreadId: "replacement", threadId: "after-close" }),
    ).toThrow("closed");
  });

  it("bounds context and rejects invalid requests or aborted registrations", () => {
    const { controller, register, prepare, rejects } = fixture();
    expect(() => register("x".repeat(256 * 1024 + 1))).toThrow("limit");
    const registered = register("private");
    const source = request("root", registered.generation);
    rejects({ ...source, instructions: null }, "instructions");
    rejects({ instructions: "base" }, "metadata");
    const invalidMetadata: JsonObject[] = [
      { thread_id: "x".repeat(257) },
      { auto_review_enabled: "true" },
    ];
    for (const extra of invalidMetadata) {
      rejects(request("root", registered.generation, extra), "metadata");
    }
    rejects(
      { client_metadata: { "x-codex-turn-metadata": "x".repeat(1024 * 1024 + 1) } },
      "bounded native metadata",
    );
    rejects(request("root", registered.generation, { request_kind: "other" }), "purpose");
    const prepared = prepare(source);
    controller.abort();
    expect(prepared.signal?.aborted).toBe(true);
    rejects(source, "current admitted");
  });
});
