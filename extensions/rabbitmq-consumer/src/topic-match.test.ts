import { describe, expect, it } from "vitest";
import { longestCommonSubstringLength, pickTopicByName } from "./topic-match.js";
import type { TopicInfo } from "./topic-resolver.js";

const t = (topicId: number, topicName: string | null): TopicInfo => ({
  topicId,
  useSlaveTopic: false,
  masterId: topicId,
  topicName,
});

describe("longestCommonSubstringLength", () => {
  it("finds the longest contiguous overlap", () => {
    expect(longestCommonSubstringLength("用模板做一个南方基金6月的报告", "南方基金")).toBe(4);
  });

  it("is zero for no overlap or empty input", () => {
    expect(longestCommonSubstringLength("abc", "xyz")).toBe(0);
    expect(longestCommonSubstringLength("", "南方基金")).toBe(0);
  });
});

describe("pickTopicByName", () => {
  const topics = [t(89, "广汽本田"), t(204, "南方基金"), t(305, "招商证券")];

  it("matches the requirement-named project within the authorized set", () => {
    const match = pickTopicByName("用这个模板做一个南方基金6月3号到6月8号的报告", topics);
    expect(match?.topicId).toBe(204);
  });

  it("returns null when no title is referenced (caller keeps the primary topic)", () => {
    expect(pickTopicByName("帮我生成今天的日报", topics)).toBeNull();
  });

  it("ignores topics that have no title", () => {
    expect(pickTopicByName("南方基金报告", [t(1, null), t(2, "南方基金")])?.topicId).toBe(2);
  });

  it("prefers the more specific (longer-overlap) title", () => {
    const match = pickTopicByName("南方基金舆情周报", [t(1, "南方基金"), t(2, "南方基金舆情专题")]);
    expect(match?.topicId).toBe(2);
  });

  it("returns null for an empty requirement", () => {
    expect(pickTopicByName("", topics)).toBeNull();
  });

  // Regression: "深圳农行的舆情日报" used to match "涉深舆情-网络动态参阅" because
  // the shared generic word "舆情" scored 2 and the longer noise title won the
  // tie-break, overriding the real 农行 topic.
  it("does not match a noise topic on shared generic words (舆情/日报)", () => {
    const candidates = [t(358, "涉深舆情-网络动态参阅"), t(89, "农业银行深圳市分行")];
    const match = pickTopicByName("帮我出一个深圳农行的舆情日报", candidates);
    expect(match?.topicId).toBe(89);
    expect(match?.topicId).not.toBe(358);
  });

  it("returns null (keep primary) when only generic words overlap", () => {
    // After stripping 舆情/网络/动态/参阅 the noise title is just "涉深"; the
    // request shares only the single char "深", below the 2-char threshold.
    expect(
      pickTopicByName("本月舆情网络动态参阅日报", [t(358, "涉深舆情-网络动态参阅")]),
    ).toBeNull();
  });

  it("still matches a real entity even when wrapped in generic words", () => {
    const candidates = [t(358, "涉深舆情-网络动态参阅"), t(204, "南方基金")];
    expect(pickTopicByName("帮我生成南方基金的舆情日报", candidates)?.topicId).toBe(204);
  });
});
