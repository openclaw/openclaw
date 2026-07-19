// Tlon tests cover non-interactive setup validation and config writes.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { tlonSetupAdapter } from "./setup-core.js";

const validInput = {
  ship: "~sampel-palnet",
  url: "https://urbit.example.com",
  code: "lidlut-tabwed-pillex-ridrup",
};

function validate(params: {
  cfg?: OpenClawConfig;
  input: Parameters<NonNullable<typeof tlonSetupAdapter.validateInput>>[0]["input"];
}) {
  return tlonSetupAdapter.validateInput?.({
    cfg: params.cfg ?? {},
    accountId: DEFAULT_ACCOUNT_ID,
    input: params.input,
  });
}

async function prepare(
  input: Parameters<NonNullable<typeof tlonSetupAdapter.prepareAccountConfigInput>>[0]["input"],
) {
  return await tlonSetupAdapter.prepareAccountConfigInput?.({
    cfg: {},
    accountId: DEFAULT_ACCOUNT_ID,
    input,
    runtime: createNonExitingRuntimeEnv(),
  });
}

describe("Tlon setup adapter", () => {
  it.each([
    ["file:///etc/passwd", "Invalid URL: URL must use http:// or https://"],
    ["https://user:password@urbit.example.com", "Invalid URL: URL must not include credentials"],
    ["https://", "Invalid URL: Invalid URL"],
  ])("rejects a URL the runtime cannot use: %s", (url, expected) => {
    expect(validate({ input: { ...validInput, url } })).toBe(expected);
  });

  it("accepts the same bare-host and path URL forms as the runtime", () => {
    expect(
      validate({ input: { ...validInput, url: "urbit.example.com/~/login?redirect=1" } }),
    ).toBe(null);
  });

  it("validates the resolved URL when an existing account supplies it", () => {
    const cfg = {
      channels: {
        tlon: validInput,
      },
    } as OpenClawConfig;

    expect(validate({ cfg, input: { code: "replacement-code" } })).toBeNull();
    expect(
      validate({
        cfg: {
          channels: { tlon: { ...validInput, url: "ftp://urbit.example.com" } },
        } as OpenClawConfig,
        input: { code: "replacement-code" },
      }),
    ).toBe("Invalid URL: URL must use http:// or https://");
  });

  it("normalizes an explicit URL before the adapter writes config", async () => {
    const input = await prepare({
      ...validInput,
      url: " urbit.example.com/~/login?redirect=1 ",
    });
    expect(input?.url).toBe("https://urbit.example.com");

    const cfg = tlonSetupAdapter.applyAccountConfig({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input: input ?? {},
    });
    expect(cfg.channels?.tlon?.url).toBe("https://urbit.example.com");
  });
});
