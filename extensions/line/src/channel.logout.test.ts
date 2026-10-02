import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveLineAccount } from "./accounts.js";
import { lineGatewayAdapter } from "./gateway.js";
import { setLineRuntime } from "./runtime.js";

let tempDir: string;
async function logout(cfg: OpenClawConfig, accountId = "default") {
  const original = structuredClone(cfg);
  const runtime = createPluginRuntimeMock();
  setLineRuntime(runtime);
  const result = await lineGatewayAdapter.logoutAccount!({
    accountId,
    cfg,
    account: resolveLineAccount({ cfg, accountId }),
    runtime: createRuntimeEnv(),
  });
  expect(cfg).toEqual(original);
  return { result, replace: vi.mocked(runtime.config.replaceConfigFile) };
}

describe("LINE account logout", () => {
  beforeEach(async () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "");
    vi.stubEnv("LINE_CHANNEL_SECRET", "");
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-logout-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clears default file credentials and prunes the empty channel", async () => {
    const { result, replace } = await logout({
      channels: {
        line: {
          channelAccessToken: "",
          channelSecret: "",
          tokenFile: path.join(tempDir, "token"),
          secretFile: path.join(tempDir, "secret"),
        },
      },
    });
    expect(result).toEqual({ cleared: true, envToken: false, loggedOut: true });
    expect(replace).toHaveBeenCalledWith({ nextConfig: {}, afterWrite: { mode: "auto" } });
  });

  it("does not write when the account has no credential fields", async () => {
    const { result, replace } = await logout(
      {
        channels: {
          line: {
            accounts: { primary: { name: "Primary" } },
          },
        },
      },
      "primary",
    );
    expect(result).toEqual({ cleared: false, envToken: false, loggedOut: true });
    expect(replace).not.toHaveBeenCalled();
  });

  it("clears empty named credential fields and preserves sibling config", async () => {
    const sibling = { channelAccessToken: "keep-token", name: "Other" };
    const line = { name: "LINE", accounts: { primary: { name: "Primary" }, other: sibling } };
    const { result, replace } = await logout(
      {
        channels: {
          line: {
            ...line,
            accounts: {
              ...line.accounts,
              primary: {
                ...line.accounts.primary,
                channelAccessToken: "",
                channelSecret: "",
                tokenFile: "",
                secretFile: "",
              },
            },
          },
          telegram: { enabled: false },
        },
      },
      "primary",
    );
    expect(result).toEqual({ cleared: true, envToken: false, loggedOut: true });
    expect(replace).toHaveBeenCalledExactlyOnceWith({
      nextConfig: { channels: { line, telegram: { enabled: false } } },
      afterWrite: { mode: "auto" },
    });
  });
});
