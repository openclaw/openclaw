import { describe, expect, it } from "vitest";
import { parseClassificationResponse, runRuleBasedClassification } from "./tools";

describe("parseClassificationResponse", () => {
  it("parses valid JSON response", () => {
    const result = parseClassificationResponse(
      '{"type":"fact","importance":7,"confidence":0.85,"summary_refined":"user likes pizza","keywords":"pizza food"}',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("fact");
    expect(result!.importance).toBe(7);
    expect(result!.confidence).toBe(0.85);
  });

  it("extracts JSON from markdown code fences", () => {
    const result = parseClassificationResponse(
      '```json\n{"type":"event","importance":5,"confidence":0.8,"summary_refined":"went to park","keywords":"park"}\n```',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("event");
  });

  it("rejects unknown type", () => {
    const result = parseClassificationResponse(
      '{"type":"unknown","importance":5,"confidence":0.8,"summary_refined":"test","keywords":"test"}',
    );
    expect(result).toBeNull();
  });

  it("clamps importance to 1-10", () => {
    const r1 = parseClassificationResponse(
      '{"type":"fact","importance":15,"confidence":0.8,"summary_refined":"test","keywords":"test"}',
    );
    expect(r1!.importance).toBe(10);

    const r2 = parseClassificationResponse(
      '{"type":"fact","importance":-3,"confidence":0.8,"summary_refined":"test","keywords":"test"}',
    );
    expect(r2!.importance).toBe(1);
  });

  it("clamps confidence to 0-1", () => {
    const r1 = parseClassificationResponse(
      '{"type":"fact","importance":5,"confidence":2.5,"summary_refined":"test","keywords":"test"}',
    );
    expect(r1!.confidence).toBe(1);

    const r2 = parseClassificationResponse(
      '{"type":"fact","importance":5,"confidence":-0.5,"summary_refined":"test","keywords":"test"}',
    );
    expect(r2!.confidence).toBe(0);
  });

  it("truncates summary to 100 chars", () => {
    const longText = "a".repeat(200);
    const result = parseClassificationResponse(
      `{"type":"fact","importance":5,"confidence":0.8,"summary_refined":"${longText}","keywords":"test"}`,
    );
    expect(result!.summary_refined.length).toBeLessThanOrEqual(100);
  });

  it("sanitizes keywords", () => {
    const result = parseClassificationResponse(
      '{"type":"fact","importance":5,"confidence":0.8,"summary_refined":"test","keywords":"Hello, World! 测试"}',
    );
    expect(result!.keywords).not.toContain(",");
    expect(result!.keywords).not.toContain("!");
  });

  it("returns null for empty input", () => {
    expect(parseClassificationResponse("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseClassificationResponse("not json at all")).toBeNull();
  });

  it("returns null for missing fields", () => {
    expect(parseClassificationResponse('{"type":"fact"}')).toBeNull();
  });
});

describe("runRuleBasedClassification", () => {
  it("classifies correction pattern", () => {
    const r = runRuleBasedClassification("不对，上次我说的不对");
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(0.9);
  });

  it("classifies rule with mandatory words", () => {
    const r = runRuleBasedClassification("必须每天早上打卡");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("rule");
    expect(r!.confidence).toBe(0.9);
  });

  it("classifies rule with prohibition words", () => {
    const cases = ["禁止吸烟", "不得泄露", "不准迟到", "严禁烟火"];
    for (const c of cases) {
      expect(runRuleBasedClassification(c)?.type).toBe("rule");
    }
  });

  it("classifies preference with dislike", () => {
    const r = runRuleBasedClassification("我不喜欢吃辣");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("preference");
    expect(r!.confidence).toBe(0.85);
  });

  it("classifies preference with comparative", () => {
    const cases = ["我更喜欢远程办公", "最好用vscode", "我倾向打车而不是地铁"];
    for (const c of cases) {
      expect(runRuleBasedClassification(c)?.type).toBe("preference");
    }
  });

  it("returns null for non-matching text", () => {
    expect(runRuleBasedClassification("今天天气不错")).toBeNull();
    expect(runRuleBasedClassification("好的我知道了")).toBeNull();
  });

  it("correction beats rule in priority", () => {
    const r = runRuleBasedClassification("不对，不是必须的");
    // correction matches first, returns fact
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(0.9);
  });
});
