// Feishu tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function feishuConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { feishu: entry } } as never;
}

describe("feishu normalizeCompatibilityConfig streaming aliases", () => {
  it("migrates boolean streaming plus flat delivery keys into the nested shape", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        streaming: false,
        chunkMode: "newline",
        blockStreaming: true,
        blockStreamingCoalesce: { idleMs: 100 },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.streaming).toEqual({
      mode: "off",
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 100 } },
    });
    expect(feishu.chunkMode).toBeUndefined();
    expect(feishu.blockStreaming).toBeUndefined();
    expect(feishu.blockStreamingCoalesce).toBeUndefined();
  });

  it("moves tools.base to tools.bitable at root and account scope", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        tools: { base: false, doc: true },
        accounts: {
          work: { tools: { base: false } },
          canonical: { tools: { base: false, bitable: true } },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.tools).toEqual({ bitable: false, doc: true });
    const accounts = feishu.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.tools).toEqual({ bitable: false });
    expect(accounts.canonical?.tools).toEqual({ bitable: true });
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it("sanitizes legacy Feishu-only coalesce fields so doctor output validates", () => {
    // The retired Feishu coalesce schema advertised enabled/minDelayMs/
    // maxDelayMs, which no runtime path read; migrated output must still pass
    // the strict nested schema.
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        blockStreamingCoalesce: { enabled: true, minDelayMs: 100, maxDelayMs: 200 },
        accounts: {
          work: { blockStreamingCoalesce: { minDelayMs: 50 } },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.streaming).toEqual({ block: { coalesce: {} } });
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.streaming).toEqual({ block: { coalesce: {} } });
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it("strips unread legacy Feishu heartbeat fields at root and account scope", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        heartbeat: { visibility: "hidden", intervalMs: 1000 },
        accounts: {
          work: { heartbeat: { visibility: "visible" } },
          empty: { heartbeat: {} },
        },
      }),
    });

    const feishu = result.config.channels?.feishu as unknown as Record<string, unknown>;
    expect(feishu.heartbeat).toBeUndefined();
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;
    expect(work?.heartbeat).toBeUndefined();
    const empty = (feishu.accounts as Record<string, Record<string, unknown>>).empty;
    expect(empty?.heartbeat).toBeUndefined();
    expect(result.changes).toEqual([
      "Removed channels.feishu.heartbeat (legacy Feishu fields were never read by runtime).",
      "Removed channels.feishu.accounts.work.heartbeat (legacy Feishu fields were never read by runtime).",
      "Removed channels.feishu.accounts.empty.heartbeat (legacy Feishu fields were never read by runtime).",
    ]);
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });
});

describe("feishu webhook route doctor migration", () => {
  const webhookRule = legacyConfigRules.find((rule) => rule.message.includes("webhookPath"));

  it("detects noncanonical webhook paths at root and account scope", () => {
    expect(webhookRule?.match?.({ webhookPath: "/hook#fragment" }, {})).toBe(true);
    expect(webhookRule?.match?.({ accounts: { main: { webhookPath: "hook" } } }, {})).toBe(true);
    expect(webhookRule?.match?.({ webhookPath: "/hook/?tenant=alpha" }, {})).toBe(false);
  });

  it.each([
    ["/hook?", "/hook?"],
    ["   ", "/feishu/events"],
    ["javascript:alert(1)", "/feishu/events"],
  ])("repairs root and account webhook path %j to %j", (webhookPath, expectedPath) => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({ webhookPath, accounts: { main: { webhookPath } } }),
    });
    const feishu = result.config.channels?.feishu as unknown as {
      webhookPath?: string;
      accounts?: Record<string, { webhookPath?: string }>;
    };

    expect(feishu.webhookPath).toBe(expectedPath);
    expect(feishu.accounts?.main?.webhookPath).toBe(expectedPath);
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
    if (webhookPath === expectedPath) {
      expect(result.changes).toEqual([]);
    } else {
      expect(result.changes).toEqual([
        expect.stringContaining("channels.feishu.webhookPath"),
        expect.stringContaining("channels.feishu.accounts.main.webhookPath"),
      ]);
    }

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(result.config);
  });

  it("reports actionable default repairs without echoing malformed operator URLs", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({ webhookPath: "javascript:alert(operator-private-value)" }),
    });

    expect(result.changes).toEqual([
      "Reset invalid channels.feishu.webhookPath to /feishu/events.",
    ]);
  });
});

it("preserves root and account legacyWebhook:false when migrating obsolete ports", () => {
  const result = normalizeCompatibilityConfig({
    cfg: feishuConfig({
      legacyWebhook: false,
      webhookPort: 3000,
      accounts: {
        inherited: { webhookPort: 3001 },
        disabled: { webhookPort: 3002, legacyWebhook: false },
      },
    }),
  });
  expect(FeishuConfigSchema.parse(result.config.channels?.feishu).legacyWebhook).toBe(false);
  for (const accountId of ["inherited", "disabled"]) {
    expect(resolveFeishuAccount({ cfg: result.config, accountId }).config.legacyWebhook).toBe(
      false,
    );
  }
  expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
});
