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
    for (const key of [
      "session-id",
      "thread-id",
      "x-codex-parent-thread-id",
      "x-openai-subagent",
    ]) {
      expect(() => readCodexInferenceMetadata(source, { ...headers, [key]: "other" })).toThrow(
        "metadata disagrees",
      );
    }
    for (const key of ["turn_id", "parent_turn_id", "root_turn_id"]) {
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
  it("refreshes and removes overlays for native input-only requests without changing history", () => {
    const context = createCodexInferenceContext(() => {});
    const register = (text: string) =>
      context.register({
        threadId: "root",
        text,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
    const inputOnly = (generation: string) => {
      const source = request("root", generation);
      delete source.instructions;
      source.input = [
        { id: "at_native_tools", type: "additional_tools", role: "developer", tools: [] },
        {
          id: "msg_native_base",
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "native base" }],
        },
      ];
      return source;
    };
    const first = register("persona A");
    const source = inputOnly(first.generation);
    const prepared = context.prepare(source);
    expect(prepared.body).toEqual({ ...source, instructions: "persona A" });
    expect(prepared.body.input).toBe(source.input);
    expect(source).not.toHaveProperty("instructions");
    const second = register("persona B");
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => context.prepare(source)).toThrow("current admitted");
    const continuation = {
      ...inputOnly(second.generation),
      input: [],
      previous_response_id: "previous",
    };
    expect(context.prepare(continuation).body).toEqual({
      ...continuation,
      instructions: "persona B",
    });
    const removed = inputOnly(register("").generation);
    expect(context.prepare(removed).body).toBe(removed);
    context.close();
  });

  it.each([null, 42, false, [], {}].map((instructions) => ({ instructions })))(
    "rejects explicit non-string instructions: $instructions",
    ({ instructions }) => {
      const context = createCodexInferenceContext(() => {});
      const registration = context.register({
        threadId: "root",
        text: "persona",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      expect(() =>
        context.prepare({ ...request("root", registration.generation), instructions }),
      ).toThrow("instructions");
      context.close();
    },
  );

  it("refreshes and removes parent instructions without rewriting native history or affecting children", () => {
    const context = createCodexInferenceContext(() => {});
    const register = (text: string) =>
      context.register({
        threadId: "root",
        text,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
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
    const context = createCodexInferenceContext(() => {});
    const register = context.register({
      threadId: "root",
      text: "private",
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (!active) {
          throw new Error("owner retired");
        }
      },
    });
    const source = request("root", register.generation);
    const prepared = context.prepare(source);
    expect(() => context.prepare(request("other", register.generation))).toThrow(
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
            [CODEX_INFERENCE_GENERATION_KEY]: register.generation,
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
            [CODEX_INFERENCE_GENERATION_KEY]: register.generation,
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
    const context = createCodexInferenceContext(() => {});
    const registration = context.register({
      threadId: "root",
      text: "persona B",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
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

  it("reuses compact HTTP metadata without injecting parent instructions or requiring body metadata", () => {
    const context = createCodexInferenceContext(() => {});
    const registration = context.register({
      threadId: "root",
      text: "private persona",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const compact = { instructions: "native compact instructions", input: [] };
    const metadata = readCodexInferenceMetadata(compact, {
      "session-id": "session",
      "thread-id": "root",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "session",
        thread_id: "root",
        turn_id: "compact-turn",
        request_kind: "compaction",
        [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
      }),
    });
    expect(metadata).toMatchObject({
      threadId: "root",
      sessionId: "session",
      turnId: "compact-turn",
      requestKind: "compaction",
    });
    expect(context.prepare(compact, metadata).body).toBe(compact);
    context.close();
  });

  it("bounds context and fences aborts, missing metadata and unsupported request kinds", () => {
    const context = createCodexInferenceContext(() => {});
    const controller = new AbortController();
    const params = { threadId: "root", signal: controller.signal, assertCurrent: () => {} };
    expect(() => context.register({ ...params, text: "x".repeat(256 * 1024 + 1) })).toThrow(
      "limit",
    );
    const registered = context.register({ ...params, text: "private" });
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
