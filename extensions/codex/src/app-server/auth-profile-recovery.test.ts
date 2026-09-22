import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  resolveCodexAppServerPreparedAuthHandoff,
} from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import { getSharedCodexAppServerClient } from "./shared-client.js";

afterEach(() => vi.restoreAllMocks());

describe("Codex auth profile recovery", () => {
  it("identifies a missing selected profile before preparing a subscription handoff", async () => {
    await expect(
      resolveCodexAppServerPreparedAuthHandoff({
        authRequirement: "subscription",
        authProfileId: "openai:work",
        authProfileStore: { version: 1, profiles: {} },
        agentDir: "/tmp/openclaw-agent",
        homeScope: "agent",
        subscriptionProfileRequiredError: "profile required",
        subscriptionProfileUnusableError: "profile unusable",
      }),
    ).rejects.toMatchObject({
      code: "selected_auth_profile_unavailable",
      message: expect.stringContaining("was not found in the OpenClaw credential store"),
    });
  });

  it("reports a missing subscription profile without attempting provider auth or an API key", async () => {
    const request = vi.fn();
    const rejection = await applyCodexAppServerAuthProfile({
      client: { request } as never,
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:work",
      authProfileStore: { version: 1, profiles: {} },
      authRequirement: "subscription",
      startOptions: {
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        headers: {},
        env: { CODEX_API_KEY: "synthetic-api-key" },
      },
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      code: "selected_auth_profile_unavailable",
      message: expect.stringContaining(
        'auth profile "openai:work" was not found in the OpenClaw credential store.',
      ),
    });
    expect(rejection).not.toHaveProperty("status");
    expect((rejection as Error).message).not.toMatch(/sign in again|re-authenticate|HTTP 401/);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a missing prepared profile before starting a client", async () => {
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    const rejection = await getSharedCodexAppServerClient({
      startOptions: { transport: "stdio", command: "codex", args: ["app-server"], headers: {} },
      agentDir: "/tmp/openclaw-agent",
      preparedAuth: {
        kind: "profile",
        profileId: "openai:work",
        store: { version: 1, profiles: {} },
      },
    }).catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      code: "selected_auth_profile_unavailable",
      message: expect.stringContaining("was not found in the OpenClaw credential store"),
    });
    expect(rejection).not.toHaveProperty("status");
    expect(startSpy).not.toHaveBeenCalled();
  });
});
