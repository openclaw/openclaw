import { describe, expect, it } from "vitest";
import {
  clampMaxBytes,
  DEFAULT_MAX_BYTES,
  HARD_MAX_BYTES,
  resolveAzureBlobAccountName,
  resolveAzureBlobConnectionString,
  resolveAzureBlobDefaultContainer,
} from "./config.js";

describe("azure-blob config", () => {
  it("clamps max bytes to defaults and hard cap", () => {
    expect(clampMaxBytes(undefined)).toBe(DEFAULT_MAX_BYTES);
    expect(clampMaxBytes(Number.NaN)).toBe(DEFAULT_MAX_BYTES);
    expect(clampMaxBytes(500)).toBe(500);
    expect(clampMaxBytes(HARD_MAX_BYTES + 1)).toBe(HARD_MAX_BYTES);
  });

  it("reads connection string from plugin config", () => {
    const cs = resolveAzureBlobConnectionString({
      plugins: {
        entries: {
          "azure-blob": {
            config: { connectionString: "UseDevelopmentStorage=true" },
          },
        },
      },
    } as Parameters<typeof resolveAzureBlobConnectionString>[0]);
    expect(cs).toBe("UseDevelopmentStorage=true");
  });

  it("reads default container from plugin config", () => {
    expect(
      resolveAzureBlobDefaultContainer({
        plugins: {
          entries: {
            "azure-blob": { config: { defaultContainer: "my-data" } },
          },
        },
      } as Parameters<typeof resolveAzureBlobDefaultContainer>[0]),
    ).toBe("my-data");
  });

  it("reads account name from plugin config", () => {
    expect(
      resolveAzureBlobAccountName({
        plugins: {
          entries: {
            "azure-blob": { config: { accountName: "acct" } },
          },
        },
      } as Parameters<typeof resolveAzureBlobAccountName>[0]),
    ).toBe("acct");
  });
});
