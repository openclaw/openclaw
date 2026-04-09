import { describe, it, expect } from "vitest";
import { cleanStaleFeishuConfig } from "./doctor.js";

describe("cleanStaleFeishuConfig", () => {
  it("returns unchanged config when no feishu channel", async () => {
    const cfg = {} as Parameters<typeof cleanStaleFeishuConfig>[0]["cfg"];
    const result = await cleanStaleFeishuConfig({ cfg });
    expect(result.changes).toHaveLength(0);
    expect(result.config).toBe(cfg);
  });

  it("returns unchanged config when feishu config has no deprecated keys", async () => {
    const cfg = {
      channels: { feishu: { appId: "test-app", enabled: true } },
    } as Parameters<typeof cleanStaleFeishuConfig>[0]["cfg"];
    const result = await cleanStaleFeishuConfig({ cfg });
    expect(result.changes).toHaveLength(0);
  });

  it("removes top-level ackReaction deprecated key", async () => {
    const cfg = {
      channels: { feishu: { appId: "test-app", ackReaction: "👍" } },
    } as Parameters<typeof cleanStaleFeishuConfig>[0]["cfg"];
    const result = await cleanStaleFeishuConfig({ cfg });
    expect(result.changes.some((c) => c.includes('channels.feishu.ackReaction'))).toBe(true);
    const feishu = (result.config.channels as Record<string, Record<string, unknown>>).feishu;
    expect(feishu).not.toHaveProperty("ackReaction");
    expect(feishu).toHaveProperty("appId");
  });

  it("removes top-level threadSession deprecated key", async () => {
    const cfg = {
      channels: { feishu: { appId: "test-app", threadSession: true } },
    } as Parameters<typeof cleanStaleFeishuConfig>[0]["cfg"];
    const result = await cleanStaleFeishuConfig({ cfg });
    expect(result.changes.some((c) => c.includes('channels.feishu.threadSession'))).toBe(true);
    const feishu = (result.config.channels as Record<string, Record<string, unknown>>).feishu;
    expect(feishu).not.toHaveProperty("threadSession");
  });

  it("removes deprecated keys from account-level config", async () => {
    const cfg = {
      channels: {
        feishu: {
          appId: "test-app",
          accounts: {
            default: { appId: "account-app", ackReaction: "👍" },
          },
        },
      },
    } as Parameters<typeof cleanStaleFeishuConfig>[0]["cfg"];
    const result = await cleanStaleFeishuConfig({ cfg });
    expect(
      result.changes.some((c) => c.includes("channels.feishu.accounts.default.ackReaction")),
    ).toBe(true);
  });

  it("removes both ackReaction and threadSession when both present", async () => {
    const cfg = {
      channels: {
        feishu: { appId: "test-app", ackReaction: "👍", threadSession: true },
      },
    } as Parameters<typeof cleanStaleFeishuConfig>[0]["cfg"];
    const result = await cleanStaleFeishuConfig({ cfg });
    expect(result.changes).toHaveLength(2);
    const feishu = (result.config.channels as Record<string, Record<string, unknown>>).feishu;
    expect(feishu).not.toHaveProperty("ackReaction");
    expect(feishu).not.toHaveProperty("threadSession");
    expect(feishu).toHaveProperty("appId");
  });
});
