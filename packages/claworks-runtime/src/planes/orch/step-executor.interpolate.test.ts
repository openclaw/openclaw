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
});
