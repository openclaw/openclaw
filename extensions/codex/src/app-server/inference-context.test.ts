import { describe, expect, it } from "vitest";
import {
  CODEX_INFERENCE_GENERATION_KEY,
  createCodexInferenceContext,
} from "./inference-context.js";
import type { JsonObject } from "./protocol.js";

function request(threadId: string, generation?: string, extra: JsonObject = {}): JsonObject {
  return {
    instructions: "native base",
    input: [{ role: "developer", content: "native catalog collaboration" }],
    client_metadata: {
      thread_id: threadId,
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        request_kind: "turn",
        ...(generation ? { [CODEX_INFERENCE_GENERATION_KEY]: generation } : {}),
        ...extra,
      }),
    },
  };
}

describe("parent-local inference context", () => {
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
    // client_metadata still carries the physical thread ID (0.153.4 responses_metadata.rs).
    const memory = {
      instructions: "native memory instructions",
      input: [],
      client_metadata: {
        thread_id: "memory-thread",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }),
      },
    };
    expect(context.prepare(memory).body).toEqual(memory);
    const startup = { ...request("root", undefined, { request_kind: "prewarm" }), generate: false };
    expect(context.prepare(startup).body).toEqual(startup);
    // Immediate normal continuation after compaction still reads the current snapshot.
    expect(context.prepare(request("root", registration.generation)).body.instructions).toContain(
      "persona B",
    );
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
