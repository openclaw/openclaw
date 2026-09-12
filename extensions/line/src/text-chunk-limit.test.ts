// Line tests cover text-chunk-limit plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { lineOutboundAdapter } from "./outbound.js";
import { LINE_TEXT_CHUNK_LIMIT, resolveLineTextChunkLimit } from "./text-chunk-limit.js";

const cfgWith = (line: Record<string, unknown>): OpenClawConfig => ({ channels: { line } });

describe("resolveLineTextChunkLimit", () => {
  it.each([
    {
      name: "falls back to what LINE accepts when nothing is configured",
      cfg: cfgWith({}),
      accountId: "default",
      expected: LINE_TEXT_CHUNK_LIMIT,
    },
    {
      name: "uses the channel-wide limit",
      cfg: cfgWith({ textChunkLimit: 800 }),
      accountId: "default",
      expected: 800,
    },
    {
      name: "prefers the account limit over the channel-wide one",
      cfg: cfgWith({ textChunkLimit: 800, accounts: { work: { textChunkLimit: 300 } } }),
      accountId: "work",
      expected: 300,
    },
    {
      name: "bounds a channel limit LINE would reject",
      cfg: cfgWith({ textChunkLimit: 9000 }),
      accountId: "default",
      expected: LINE_TEXT_CHUNK_LIMIT,
    },
    {
      name: "bounds an account limit LINE would reject",
      cfg: cfgWith({ accounts: { work: { textChunkLimit: 9000 } } }),
      accountId: "work",
      expected: LINE_TEXT_CHUNK_LIMIT,
    },
  ])("$name", ({ cfg, accountId, expected }) => {
    expect(resolveLineTextChunkLimit({ cfg, accountId })).toBe(expected);
  });
});

describe("the chunk limit core plans outbound sends with", () => {
  it("bounds the chunk limit core plans with", () => {
    expect(
      lineOutboundAdapter.resolveEffectiveTextChunkLimit?.({
        cfg: cfgWith({ textChunkLimit: 9000 }),
        accountId: "primary",
        fallbackLimit: 9000,
      }),
    ).toBe(LINE_TEXT_CHUNK_LIMIT);
  });

  it("plans with a configured limit below the platform cap, per account", () => {
    // A cap-only assertion cannot tell this seam apart from one that ignores the
    // config and returns the constant, which is the whole point of reading it.
    const cfg = cfgWith({ textChunkLimit: 4000, accounts: { work: { textChunkLimit: 900 } } });

    expect(
      lineOutboundAdapter.resolveEffectiveTextChunkLimit?.({
        cfg,
        accountId: "work",
        fallbackLimit: 5000,
      }),
    ).toBe(900);
    expect(
      lineOutboundAdapter.resolveEffectiveTextChunkLimit?.({
        cfg,
        accountId: "other",
        fallbackLimit: 5000,
      }),
    ).toBe(4000);
  });
});
