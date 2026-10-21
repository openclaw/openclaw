import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordToken } from "./token.js";

const secret = (id: string) => ({ source: "env" as const, provider: "default", id });
const config = (discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig => ({
  channels: { discord },
});

describe("resolveDiscordToken", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    const cfg = config({ token: "base-token", accounts: { work: { token: "" } } });
    expect(resolveDiscordToken(cfg, { accountId: "work" })).toEqual({
      token: "",
      source: "none",
      tokenStatus: "missing",
    });
  });

  it("uses the active runtime snapshot when resolving a matching source config", () => {
    const sourceCfg = config({ accounts: { work: { token: secret("DISCORD_WORK_TOKEN") } } });
    const runtimeCfg = config({ accounts: { work: { token: "Bot runtime-work-token" } } });
    setRuntimeConfigSnapshot(runtimeCfg, sourceCfg);

    expect(resolveDiscordToken(sourceCfg, { accountId: "work" })).toEqual({
      token: "runtime-work-token",
      source: "config",
      tokenStatus: "available",
    });
  });

  it("treats unresolved top-level SecretRefs as configured unavailable without env fallback", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = config({ token: secret("DISCORD_BOT_TOKEN") });
    expect(resolveDiscordToken(cfg)).toEqual({
      token: "",
      source: "config",
      tokenStatus: "configured_unavailable",
    });
  });

  it("treats unresolved account SecretRefs as configured unavailable without top-level fallback", () => {
    const cfg = config({
      token: "base-token",
      accounts: { work: { token: secret("DISCORD_WORK_TOKEN") } },
    });
    expect(resolveDiscordToken(cfg, { accountId: "work" })).toEqual({
      token: "",
      source: "config",
      tokenStatus: "configured_unavailable",
    });
  });
});
