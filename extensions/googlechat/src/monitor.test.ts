import { type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { isSenderAllowed } from "./monitor.js";
import { startGoogleChatMonitor } from "./monitor.js";
import { setGoogleChatRuntime } from "./runtime.js";

describe("isSenderAllowed", () => {
  it("matches allowlist entries with raw email", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"])).toBe(true);
  });

  it("does not treat users/<email> entries as email allowlist (deprecated form)", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["users/jane@example.com"])).toBe(
      false,
    );
  });

  it("keeps Google Chat webhook monitor alive until abort signal", async () => {
    const runtime = {
      logging: {
        shouldLogVerbose: () => false,
      },
    } as PluginRuntime;
    setGoogleChatRuntime(runtime);

    const account: ResolvedGoogleChatAccount = {
      accountId: "default",
      enabled: true,
      config: {
        webhookPath: "/googlechat",
      },
      credentialSource: "none",
    };

    const abortController = new AbortController();
    const monitor = startGoogleChatMonitor({
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      abortSignal: abortController.signal,
      webhookPath: "/googlechat",
    });

    await expect(Promise.race([monitor, Promise.resolve("pending")])).resolves.toBe("pending");

    abortController.abort();
    await expect(monitor).resolves.toBeTypeOf("function");
  });

  it("still matches user id entries", () => {
    expect(isSenderAllowed("users/abc", "jane@example.com", ["users/abc"])).toBe(true);
  });

  it("rejects non-matching raw email entries", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["other@example.com"])).toBe(false);
  });
});
