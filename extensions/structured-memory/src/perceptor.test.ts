import { describe, expect, it } from "vitest";
import { analyzeMessage } from "./perceptor";

describe("perceptor analyzeMessage", () => {
  describe("correction detection", () => {
    it('detects "不对" as correction', () => {
      const r = analyzeMessage("不对，我上次说的不对");
      expect(r.signal).not.toBeNull();
      expect(r.signal!.source).toBe("correction");
      expect(r.signal!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("detects explicit correction patterns", () => {
      const cases = ["你记错了，我不住在那里", "搞错了，不是这样的", "纠正一下，我之前说的是错的"];
      for (const c of cases) {
        expect(analyzeMessage(c).signal?.source).toBe("correction");
      }
    });
  });

  describe("rule/constraint detection", () => {
    it("detects mandatory words as rules", () => {
      const cases = [
        "必须每天早上8点前打卡",
        "禁止在办公室吸烟",
        "不得泄露客户信息",
        "一定要先备份再操作",
      ];
      for (const c of cases) {
        const r = analyzeMessage(c);
        expect(r.signal?.source).toBe("rule_constraint");
        expect(r.signal?.confidence).toBeGreaterThanOrEqual(0.85);
      }
    });

    it("has higher priority than preference", () => {
      const r = analyzeMessage("我不喜欢开会，但必须参加");
      expect(r.signal?.source).toBe("rule_constraint");
    });
  });

  describe("preference detection", () => {
    it("detects dislike patterns", () => {
      const r = analyzeMessage("我不喜欢吃香菜");
      expect(r.signal).not.toBeNull();
      expect(r.signal!.source).toBe("explicit_preference");
      expect(r.signal!.type).toBe("preference");
    });

    it("detects comparative preference", () => {
      const cases = [
        "我更倾向用Python而不是Java",
        "最好用vscode",
        "我更喜欢远程办公",
        "受不了开会太多",
      ];
      for (const c of cases) {
        expect(analyzeMessage(c).signal?.source).toBe("explicit_preference");
      }
    });
  });

  describe("time commitment detection", () => {
    it("detects deadline patterns", () => {
      const r = analyzeMessage("周五之前要提交报告");
      expect(r.signal?.source).toBe("time_commitment");
      expect(r.signal?.type).toBe("plan");
    });

    it("detects scheduled actions", () => {
      const cases = [
        "下周我要去北京出差",
        "月底前要完成项目",
        "明天准备去看医生",
        "下个月打算学车",
      ];
      for (const c of cases) {
        expect(analyzeMessage(c).signal?.source).toBe("time_commitment");
      }
    });

    it("has lower priority than rules", () => {
      const r = analyzeMessage("下周三之前必须交报告");
      expect(r.signal?.source).toBe("rule_constraint");
    });
  });

  describe("identity detection", () => {
    it("detects name introduction", () => {
      const r = analyzeMessage("我叫张三");
      expect(r.signal?.source).toBe("identity");
    });

    it("detects residence", () => {
      const r = analyzeMessage("我住在杭州西湖区");
      expect(r.signal?.source).toBe("identity");
      expect(r.signal!.type).toBe("fact");
    });

    it("detects profession", () => {
      const r = analyzeMessage("我是一名软件工程师");
      expect(r.signal?.source).toBe("identity");
    });

    it("has lowest priority", () => {
      const r = analyzeMessage("我不喜欢我叫张三这个名字");
      expect(r.signal?.source).toBe("explicit_preference");
    });

    it("requires strong match for low-signal identity", () => {
      const r = analyzeMessage("我的书在桌子上");
      expect(r.signal).toBeNull();
    });
  });

  describe("joint judgment priority", () => {
    it("correction beats rule", () => {
      const r = analyzeMessage("不对，不是必须的");
      expect(r.signal?.source).toBe("correction");
    });

    it("rule beats preference", () => {
      const r = analyzeMessage("我不喜欢但必须做");
      expect(r.signal?.source).toBe("rule_constraint");
    });

    it("preference beats time commitment", () => {
      const r = analyzeMessage("我讨厌周五之前交任务");
      expect(r.signal?.source).toBe("explicit_preference");
    });
  });

  describe("noise rejection", () => {
    it("returns null for empty text", () => {
      expect(analyzeMessage("").signal).toBeNull();
    });

    it("returns null for very short text", () => {
      expect(analyzeMessage("哦").signal).toBeNull();
      expect(analyzeMessage("好").signal).toBeNull();
    });

    it("returns null for casual chat", () => {
      const cases = ["今天天气不错", "好的我知道了", "谢谢", "嗯嗯", "哈哈笑死了"];
      for (const c of cases) {
        expect(analyzeMessage(c).signal).toBeNull();
      }
    });
  });

  describe("keyword extraction", () => {
    it("extracts Chinese keywords from signal", () => {
      const r = analyzeMessage("必须每天早上跑步");
      expect(r.signal?.keywords).toContain("早上");
      expect(r.signal?.keywords).toContain("跑步");
    });

    it("filters out stop words", () => {
      const r = analyzeMessage("我不喜欢吃香菜和辣椒");
      const kw = r.signal?.keywords ?? [];
      expect(kw).not.toContain("不");
      expect(kw).not.toContain("我");
    });
  });

  describe("performance", () => {
    it("completes under 5ms per message", () => {
      const samples = [
        "今天天气不错",
        "我叫张三，今年25岁",
        "必须每天早上跑步",
        "我不喜欢吃香菜和辣椒但你必须尊重我的选择",
        "下周五之前要提交报告给老板",
      ];
      for (const s of samples) {
        const r = analyzeMessage(s);
        expect(r.durationMs).toBeLessThan(5);
      }
    });
  });
});
