import { describe, expect, it } from "vitest";
import { interpolate } from "./step-executor.js";

describe("interpolate", () => {
  it("resolves payload and nested step results", () => {
    const vars = {
      payload: { equipment_id: "pump-9", alarm_id: "a1" },
      steps: {
        store: { status: "ok", result: { document_id: "doc-42" } },
        diagnose: { status: "ok", result: { confidence: 0.82, summary: "OK" } },
      },
    };
    expect(interpolate("{{ payload.get('equipment_id', '') }}", vars)).toBe("pump-9");
    expect(interpolate("{{ steps['store']['result'].get('document_id', '') }}", vars)).toBe(
      "doc-42",
    );
    expect(
      interpolate(
        "{{ steps['diagnose']['result'].get('summary', steps['diagnose']['result'].get('diagnosis_summary', 'Diagnosis complete')) }}",
        vars,
      ),
    ).toBe("OK");
    expect(
      interpolate(
        "confidence={{ round(float(steps['diagnose']['result'].get('confidence', 0)) * 100) }}%",
        vars,
      ),
    ).toBe("confidence=82%");
  });

  it("resolves N-level deep paths like event.payload.text", () => {
    const vars = {
      event: { payload: { text: "hello world", user_id: "u123", channel: "feishu" } },
      sentiment_result: { urgency: 0.9, sentiment: "calm" },
    };
    expect(interpolate("{{ event.payload.text }}", vars)).toBe("hello world");
    expect(interpolate("{{ event.payload.user_id }}", vars)).toBe("u123");
    expect(interpolate("{{ event.payload.channel }}", vars)).toBe("feishu");
    // 2-level path still works
    expect(interpolate("{{ sentiment_result.urgency }}", vars)).toBe("0.9");
  });

  it("resolves store_result_as variable via 2-level path", () => {
    const vars = {
      intent_result: { suggested_capability: "kb_query", confidence: 0.85, extracted: {} },
      payload: { text: "查知识库" },
    };
    expect(interpolate("{{ intent_result.suggested_capability }}", vars)).toBe("kb_query");
    expect(interpolate("{{ intent_result.confidence }}", vars)).toBe("0.85");
  });

  it("event variable is accessible via both event.payload.x and payload.x", () => {
    const input = { text: "test msg", user_id: "u1", channel: "feishu" };
    const vars = {
      ...input,
      payload: input,
      event: { payload: input },
    };
    // Both event.payload.x and payload.x resolve to the same value
    expect(interpolate("{{ event.payload.text }}", vars)).toBe("test msg");
    expect(interpolate("{{ payload.text }}", vars)).toBe("test msg");
    // payload.get() style works
    expect(interpolate("{{ payload.get('text', '') }}", vars)).toBe("test msg");
    // Direct variable access also works (from ...input spread)
    expect(interpolate("{{ user_id }}", vars)).toBe("u1");
  });

  it("字面量值：[] | length → 0", () => {
    expect(interpolate("{{ [] | length }}", {})).toBe("0");
  });

  it("字面量值：null | default('N/A') → N/A", () => {
    expect(interpolate("{{ null | default('N/A') }}", {})).toBe("N/A");
  });

  it("字面量值：'hello' | upper | replace('O', '0') → HELL0", () => {
    expect(interpolate("{{ 'hello' | upper | replace('O', '0') }}", {})).toBe("HELL0");
  });

  it("missing step + get(..., []) | length → 0", () => {
    const vars = { steps: {} };
    expect(interpolate("{{ steps['x']['result'].get('items', []) | length }}", vars)).toBe("0");
  });

  it("event.payload.data | tojson → JSON 字符串", () => {
    const vars = { event: { payload: { data: { a: 1, b: 2 } } } };
    expect(interpolate("{{ event.payload.data | tojson }}", vars)).toBe('{"a":1,"b":2}');
  });

  it("存在的 step + get('items', []) | length → 实际数组长度", () => {
    const vars = { steps: { myStep: { status: "ok", result: { items: [1, 2, 3] } } } };
    expect(interpolate("{{ steps['myStep']['result'].get('items', []) | length }}", vars)).toBe(
      "3",
    );
  });
});
