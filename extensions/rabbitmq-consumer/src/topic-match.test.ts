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
});
