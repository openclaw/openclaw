import { describe, expect, it } from "vitest";
import {
  consumeLocalConfigWriteBudget,
  getGatewayRetryAfterMs,
  isConfigHashConflict,
  isConfigPatchNoopForSnapshot,
} from "./suite-runtime-gateway.js";

describe("qa suite gateway helpers", () => {
  it("reads retry-after from the primary gateway error before appended logs", () => {
    const error = new Error(
      "rate limit exceeded for config.patch; retry after 38s\nGateway logs:\nprevious config changed since last load",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(38_000);
    expect(isConfigHashConflict(error)).toBe(false);
  });

  it("ignores stale retry-after text that only appears in appended gateway logs", () => {
    const error = new Error(
      "config changed since last load; re-run config.get and retry\nGateway logs:\nold rate limit exceeded for config.patch; retry after 38s",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(null);
    expect(isConfigHashConflict(error)).toBe(true);
  });

  it("detects cleanup config patches that would not change the snapshot", () => {
    const config = {
      tools: {
        profile: "coding",
      },
      agents: {
        list: [{ id: "qa", model: { primary: "openai/gpt-5.4" } }],
      },
    };

    expect(
      isConfigPatchNoopForSnapshot(
        config,
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed merge patches eligible for the gateway", () => {
    expect(
      isConfigPatchNoopForSnapshot(
        {
          tools: {
            deny: ["image_generate"],
          },
        },
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("allows the first three local config writes inside the gateway window", () => {
    let bucket: { count: number; windowStartMs: number } | undefined;
    const first = consumeLocalConfigWriteBudget({ bucket, nowMs: 1_000 });
    bucket = first.state;
    const second = consumeLocalConfigWriteBudget({ bucket, nowMs: 2_000 });
    bucket = second.state;
    const third = consumeLocalConfigWriteBudget({ bucket, nowMs: 3_000 });

    expect(first.waitMs).toBe(0);
    expect(second.waitMs).toBe(0);
    expect(third.waitMs).toBe(0);
    expect(third.state).toEqual({ count: 3, windowStartMs: 1_000 });
  });

  it("waits for the local config write window to reset before a fourth write", () => {
    const bucket = { count: 3, windowStartMs: 1_000 };

    expect(consumeLocalConfigWriteBudget({ bucket, nowMs: 30_000 })).toEqual({
      state: bucket,
      waitMs: 31_000,
    });
    expect(consumeLocalConfigWriteBudget({ bucket, nowMs: 61_001 })).toEqual({
      state: { count: 1, windowStartMs: 61_001 },
      waitMs: 0,
    });
  });
});
