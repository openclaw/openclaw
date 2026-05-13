import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { enforceDingtalkPolicyInvariants } from "./onboarding.ts";
import type { DingtalkConfig } from "./types/index.ts";

/**
 * 用户硬性要求：
 *   "扫码后可以百分百启动！并且可以百分百通讯！"
 *
 * 这里锁死三项不变量，任何未来改动让这些断言红 → 就是违反用户契约：
 *   1. 向导跑完 groupPolicy 必须是 "open"（否则群消息会被静默拦截）
 *   2. 若历史配置是 "allowlist + 空 allowFrom"，走完向导必须被自愈回 "open"
 *      （这是"配置完却不回消息"黑洞的根源之一）
 *   3. 多-agent 场景一致：不管前置配置什么版本，走完向导后全部收敛到一致默认
 */
function getDingtalkCfg(cfg: OpenClawConfig): DingtalkConfig | undefined {
  return cfg.channels?.["dingtalk-connector"] as DingtalkConfig | undefined;
}

function baseCfg(overrides: Partial<DingtalkConfig> = {}): OpenClawConfig {
  return {
    channels: {
      "dingtalk-connector": {
        enabled: true,
        clientId: "ding_xxx",
        clientSecret: "secret_xxx",
        ...overrides,
      } as DingtalkConfig,
    },
  } as OpenClawConfig;
}

describe("enforceDingtalkPolicyInvariants", () => {
  it("invariant #1: groupPolicy 永远被强制为 open（哪怕入参是 allowlist/disabled）", () => {
    for (const attacker of ["allowlist", "disabled", "open", undefined]) {
      const out = enforceDingtalkPolicyInvariants(
        baseCfg({ groupPolicy: attacker as DingtalkConfig["groupPolicy"] }),
      );
      expect(getDingtalkCfg(out)?.groupPolicy).toBe("open");
    }
  });

  it("invariant #2: dmPolicy=allowlist + 空 allowFrom 会被自愈回 open", () => {
    const out = enforceDingtalkPolicyInvariants(
      baseCfg({ dmPolicy: "allowlist", allowFrom: [] }),
    );
    expect(getDingtalkCfg(out)?.dmPolicy).toBe("open");
  });

  it("invariant #2b: dmPolicy=allowlist + 无 allowFrom 字段也会被自愈", () => {
    const out = enforceDingtalkPolicyInvariants(baseCfg({ dmPolicy: "allowlist" }));
    expect(getDingtalkCfg(out)?.dmPolicy).toBe("open");
  });

  it("invariant #2 尊重：dmPolicy=allowlist + 非空 allowFrom 不会被覆盖（高级用户显式收紧）", () => {
    const out = enforceDingtalkPolicyInvariants(
      baseCfg({ dmPolicy: "allowlist", allowFrom: ["user_123"] }),
    );
    expect(getDingtalkCfg(out)?.dmPolicy).toBe("allowlist");
    expect(getDingtalkCfg(out)?.allowFrom).toEqual(["user_123"]);
  });

  it("invariant #3: 多-agent 场景，不同历史配置走完向导最终 policy 完全一致", () => {
    // agent A：全新安装（无任何策略字段）
    const agentA = enforceDingtalkPolicyInvariants(baseCfg());
    // agent B：被前任手抖选了 allowlist+disabled
    const agentB = enforceDingtalkPolicyInvariants(
      baseCfg({ groupPolicy: "allowlist", dmPolicy: "allowlist", allowFrom: [] }),
    );
    // agent C：只开了 dm
    const agentC = enforceDingtalkPolicyInvariants(baseCfg({ groupPolicy: "disabled" }));

    for (const out of [agentA, agentB, agentC]) {
      expect(getDingtalkCfg(out)?.groupPolicy).toBe("open");
      // A/B/C 的 dmPolicy 要么是 undefined（A/C 从没设过），要么已被自愈回 open（B）；
      // 重点是：没有一个会以"allowlist+空名单"收场。
      const dm = getDingtalkCfg(out);
      const isStuck = dm?.dmPolicy === "allowlist" && (!dm.allowFrom || dm.allowFrom.length === 0);
      expect(isStuck).toBe(false);
    }
  });

  it("invariant #4: enabled 字段不被 policy 修复器意外翻转（要写 false 由 Stream preflight 决定）", () => {
    // 模拟：Stream preflight 失败前已经把 enabled 置 false
    const disabled = {
      channels: {
        "dingtalk-connector": {
          enabled: false,
          clientId: "ding_x",
          clientSecret: "sec_x",
          groupPolicy: "allowlist",
        } as DingtalkConfig,
      },
    } as OpenClawConfig;
    const out = enforceDingtalkPolicyInvariants(disabled);
    // policy 会被修复为 open，但 enabled=false 必须保留——Stream preflight 的拒绝决定不能被策略层静默覆盖。
    expect(getDingtalkCfg(out)?.groupPolicy).toBe("open");
    expect(getDingtalkCfg(out)?.enabled).toBe(false);
  });
});
