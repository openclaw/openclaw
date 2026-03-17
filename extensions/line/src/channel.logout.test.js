import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";
const DEFAULT_ACCOUNT_ID = "default";
function createRuntime() {
  const writeConfigFile = vi.fn(async () => {
  });
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }) => {
      const lineConfig = cfg.channels?.line ?? {};
      const entry = accountId && accountId !== DEFAULT_ACCOUNT_ID ? lineConfig.accounts?.[accountId] ?? {} : lineConfig;
      const hasToken = (
        // oxlint-disable-next-line typescript/no-explicit-any
        Boolean(entry.channelAccessToken) || Boolean(entry.tokenFile)
      );
      const hasSecret = Boolean(entry.channelSecret) || Boolean(entry.secretFile);
      return { tokenSource: hasToken && hasSecret ? "config" : "none" };
    }
  );
  const runtime = {
    config: { writeConfigFile },
    channel: { line: { resolveLineAccount } }
  };
  return { runtime, mocks: { writeConfigFile, resolveLineAccount } };
}
function resolveAccount(resolveLineAccount, cfg, accountId) {
  const resolver = resolveLineAccount;
  return resolver({ cfg, accountId });
}
async function runLogoutScenario(params) {
  const { runtime, mocks } = createRuntime();
  setLineRuntime(runtime);
  const account = resolveAccount(mocks.resolveLineAccount, params.cfg, params.accountId);
  const result = await linePlugin.gateway.logoutAccount({
    accountId: params.accountId,
    cfg: params.cfg,
    account,
    runtime: createRuntimeEnv()
  });
  return { result, mocks };
}
describe("linePlugin gateway.logoutAccount", () => {
  beforeEach(() => {
    setLineRuntime(createRuntime().runtime);
  });
  it("clears tokenFile/secretFile on default account logout", async () => {
    const cfg = {
      channels: {
        line: {
          tokenFile: "/tmp/token",
          secretFile: "/tmp/secret"
        }
      }
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID
    });
    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.writeConfigFile).toHaveBeenCalledWith({});
  });
  it("clears tokenFile/secretFile on account logout", async () => {
    const cfg = {
      channels: {
        line: {
          accounts: {
            primary: {
              tokenFile: "/tmp/token",
              secretFile: "/tmp/secret"
            }
          }
        }
      }
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: "primary"
    });
    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.writeConfigFile).toHaveBeenCalledWith({});
  });
  it("does not write config when account has no token/secret fields", async () => {
    const cfg = {
      channels: {
        line: {
          accounts: {
            primary: {
              name: "Primary"
            }
          }
        }
      }
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: "primary"
    });
    expect(result.cleared).toBe(false);
    expect(result.loggedOut).toBe(true);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
