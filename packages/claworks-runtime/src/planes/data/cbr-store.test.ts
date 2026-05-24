import { describe, expect, it } from "vitest";
import { createCbrStore, tfidfSimilarity } from "./cbr-store.js";

describe("tfidfSimilarity", () => {
  it("空输入返回 0", () => {
    const cases = new Map();
    expect(tfidfSimilarity([], ["帮助", "工单"], cases)).toBe(0);
    expect(tfidfSimilarity(["帮助"], [], cases)).toBe(0);
  });

  it("完全相同词的相似度高于部分匹配", () => {
    const cases = new Map();
    const score1 = tfidfSimilarity(["创建", "工单"], ["创建", "工单"], cases);
    const score2 = tfidfSimilarity(["创建", "工单"], ["创建", "报警"], cases);
    expect(score1).toBeGreaterThan(score2);
  });

  it("无共同词时相似度为 0", () => {
    const cases = new Map();
    expect(tfidfSimilarity(["创建", "工单"], ["查询", "报警"], cases)).toBe(0);
  });
});

describe("CbrStore.search - TF-IDF 模式", () => {
  it("案例库 ≥ 5 条时使用 TF-IDF，精确匹配排第一", () => {
    const store = createCbrStore();
    store.add("查询今日报警", "alarm.query", { tags: ["alarm"] });
    store.add("创建设备工单", "work_order.create", { tags: ["work_order"] });
    store.add("帮我看看状态", "system.status", { tags: ["status"] });
    store.add("开始巡检任务", "patrol.start", { tags: ["patrol"] });
    store.add("重启设备", "device.restart", { tags: ["device"] });
    store.add("联系班组长", "notify.supervisor", { tags: ["notify"] });

    const results = store.search("创建工单");
    expect(results.length).toBeGreaterThan(0);
    // 工单相关的案例应排第一
    expect(results[0]?.solution).toBe("work_order.create");
  });

  it("案例库 < 5 条时降级为关键词匹配", () => {
    const store = createCbrStore();
    store.add("查询报警", "alarm.query");
    store.add("创建工单", "work_order.create");

    const results = store.search("报警查询");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.solution).toBe("alarm.query");
  });

  it("中文 bigram 增强匹配短语", () => {
    const store = createCbrStore();
    // 添加足够案例触发 TF-IDF
    for (let i = 0; i < 5; i++) {
      store.add(`无关内容${i}`, `unrelated.${i}`);
    }
    store.add("设备停机故障报警", "fault.alarm.device_down");

    const results = store.search("停机报警");
    // bigram 「停机」「机故」「故障」等应帮助匹配
    expect(results.some((r) => r.solution === "fault.alarm.device_down")).toBe(true);
  });

  it("搜索返回结果 useCount 递增", () => {
    const store = createCbrStore();
    const added = store.add("查询报警情况", "alarm.query");
    expect(added.useCount).toBe(0);
    store.search("报警查询");
    const afterSearch = store.getById(added.id);
    expect(afterSearch?.useCount).toBe(1);
  });
});
