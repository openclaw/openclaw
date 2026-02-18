import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRatelimitFetchHook, readRatelimitSnapshot } from "./anthropic-ratelimit.js";

describe("anthropic-ratelimit", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-test-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Always restore fetch
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures ratelimit headers from Anthropic API responses", async () => {
    const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-limit": "1000",
          "anthropic-ratelimit-unified-remaining": "750",
          "anthropic-ratelimit-unified-reset": "2025-02-18T15:00:00Z",
          "anthropic-ratelimit-unified-tokens-limit": "100000",
          "anthropic-ratelimit-unified-tokens-remaining": "85000",
          "anthropic-ratelimit-unified-tokens-reset": "2025-02-18T14:35:00Z",
        },
      });
    };
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const hook = createRatelimitFetchHook({
      env,
      sessionKey: "test-session",
      modelId: "claude-opus-4-6",
    });

    hook.install();
    await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    hook.uninstall();

    const snapshot = readRatelimitSnapshot(env);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.headers["anthropic-ratelimit-unified-limit"]).toBe("1000");
    expect(snapshot!.headers["anthropic-ratelimit-unified-remaining"]).toBe("750");
    expect(snapshot!.headers["anthropic-ratelimit-unified-tokens-remaining"]).toBe("85000");
    expect(snapshot!.sessionKey).toBe("test-session");
    expect(snapshot!.modelId).toBe("claude-opus-4-6");
  });

  it("ignores non-Anthropic URLs", async () => {
    const mockFetch = async () => {
      return new Response("{}", {
        status: 200,
        headers: {
          "x-ratelimit-limit": "100",
        },
      });
    };
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const hook = createRatelimitFetchHook({ env, sessionKey: "test" });
    hook.install();
    await globalThis.fetch("https://api.openai.com/v1/chat/completions");
    hook.uninstall();

    const snapshot = readRatelimitSnapshot(env);
    expect(snapshot).toBeNull();
  });

  it("restores original fetch after uninstall", () => {
    const hook = createRatelimitFetchHook({ env });
    const beforeInstall = globalThis.fetch;
    hook.install();
    expect(globalThis.fetch).not.toBe(beforeInstall);
    hook.uninstall();
    expect(globalThis.fetch).toBe(beforeInstall);
  });

  it("handles responses without ratelimit headers gracefully", async () => {
    const mockFetch = async () => {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const hook = createRatelimitFetchHook({ env });
    hook.install();
    await globalThis.fetch("https://api.anthropic.com/v1/messages");
    hook.uninstall();

    // No snapshot written when no ratelimit headers present
    const snapshot = readRatelimitSnapshot(env);
    expect(snapshot).toBeNull();
  });

  it("is idempotent on double install/uninstall", () => {
    const hook = createRatelimitFetchHook({ env });
    const original = globalThis.fetch;
    hook.install();
    hook.install(); // second install is a no-op
    hook.uninstall();
    expect(globalThis.fetch).toBe(original);
    hook.uninstall(); // second uninstall is a no-op
    expect(globalThis.fetch).toBe(original);
  });
});
