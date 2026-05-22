import { describe, expect, it } from "vitest";
import { evaluatePlaybookCondition } from "./step-conditions.js";
import { interpolate } from "./step-executor.js";
import { expandJinjaForLoops, resolveLenExpression } from "./template-resolve.js";

describe("template-resolve", () => {
  it("expands for loops over step results", () => {
    const vars = {
      steps: {
        search_kb: {
          status: "ok",
          result: {
            results: [
              { text: "答案A", source: "a.md" },
              { text: "答案B", source: "b.md" },
            ],
          },
        },
      },
    };
    const out = expandJinjaForLoops(
      `{% for r in steps['search_kb']['result'].get('results', []) %}
- {{ r.get('text', '') }}
{% endfor %}`,
      vars,
    );
    expect(out).toContain("答案A");
    expect(out).toContain("答案B");
  });

  it("evaluates len(steps...) > 0", () => {
    const ok = evaluatePlaybookCondition(
      "len(steps['query_overdue']['result'].get('items', [])) > 0",
      {
        steps: {
          query_overdue: { status: "ok", result: { items: [{ title: "t1" }] } },
        },
      },
    );
    expect(ok).toBe(true);
  });

  it("interpolate uses expanded for loops in llm prompts", () => {
    const text = interpolate(
      `结果：{% for r in steps['s']['result'].get('results', []) %}{{ r.get('text', '') }}{% endfor %}`,
      {
        steps: { s: { result: { results: [{ text: "ok" }] } } },
      },
    );
    expect(text).toContain("ok");
  });
});
