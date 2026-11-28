import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordSessionRequireMention } from "./session-activation.js";

const cfg = { session: { mainKey: "main", scope: "per-sender" } } as OpenClawConfig;
const sessionKey = "agent:main:discord:channel:c1";

function withSavedMode(mode: unknown) {
  return vi
    .spyOn(sessionStore, "getSessionEntryAsync")
    .mockResolvedValue((mode === undefined ? undefined : { groupActivation: mode }) as never);
}

async function resolve(configRequireMention: boolean) {
  return await resolveDiscordSessionRequireMention({
    cfg,
    agentId: "main",
    sessionKey,
    configRequireMention,
  });
}

describe("resolveDiscordSessionRequireMention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers without a tag after /activation always, even where config requires one", async () => {
    const read = withSavedMode("always");
    expect(await resolve(true)).toBe(false);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main", sessionKey }));
  });

  it("needs a tag after /activation mention, even where config does not", async () => {
    withSavedMode("mention");
    expect(await resolve(false)).toBe(true);
  });

  it.each([true, false])("keeps the config rule (%s) for a chat with no saved mode", async (c) => {
    withSavedMode(undefined);
    expect(await resolve(c)).toBe(c);
  });

  it("keeps the config rule when the session read fails", async () => {
    vi.spyOn(sessionStore, "getSessionEntryAsync").mockRejectedValue(new Error("locked"));
    expect(await resolve(true)).toBe(true);
  });
});
