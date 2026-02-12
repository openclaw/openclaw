import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the runtime before imports
vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      }),
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
      },
    },
  }),
  setMSTeamsRuntime: vi.fn(),
}));

// Track whether authorizeJWT was called
const authorizeJWTSpy = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());

vi.mock("@microsoft/agents-hosting", () => ({
  getAuthConfigWithDefaults: (cfg: unknown) => cfg,
  MsalTokenProvider: class {
    async getAccessToken() {
      return "mock-token";
    }
  },
  ActivityHandler: class {
    onMessage() {}
    onMembersAdded() {}
    onConversationUpdate() {}
    async run(_context: unknown) {}
  },
  CloudAdapter: class {
    async process(
      _req: unknown,
      res: { status: (n: number) => { end: () => void } },
      _handler: unknown,
    ) {
      res.status(200).end();
    }
  },
  authorizeJWT: authorizeJWTSpy,
}));

vi.mock("./monitor-handler.js", () => ({
  registerMSTeamsHandlers: (_handler: unknown) => ({
    run: async () => {},
  }),
}));

vi.mock("./conversation-store-fs.js", () => ({
  createMSTeamsConversationStoreFs: () => ({}),
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreFs: () => ({}),
}));

vi.mock("./resolve-allowlist.js", () => ({
  resolveMSTeamsUserAllowlist: async () => [],
  resolveMSTeamsChannelAllowlist: async () => [],
}));

import { monitorMSTeamsProvider } from "./monitor.js";

describe("msteams monitor", () => {
  describe("JWT middleware bypass", () => {
    let result: { app: unknown; shutdown: () => Promise<void> };

    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          enabled: true,
          appId: "test-app-id",
          appPassword: "test-password",
          tenantId: "test-tenant",
          webhook: { port: 0 }, // port 0 = random available port
        },
      },
    } as unknown as OpenClawConfig;

    beforeAll(async () => {
      result = await monitorMSTeamsProvider({
        cfg,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn() as never,
        },
      });
    });

    afterAll(async () => {
      await result?.shutdown();
    });

    it("does not apply the SDK authorizeJWT middleware globally", () => {
      // authorizeJWT should NOT have been called to create middleware
      // because CloudAdapter.process() handles JWT validation internally
      expect(authorizeJWTSpy).not.toHaveBeenCalled();
    });

    it("starts the Express server successfully", () => {
      expect(result.app).toBeTruthy();
    });

    it("accepts POST requests to /api/messages without Authorization header", async () => {
      const app = result.app as import("express").Express;
      // Use supertest-like approach - make a real HTTP request
      const { createServer } = await import("node:http");
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      try {
        const response = await fetch(`http://localhost:${port}/api/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "message", text: "hello" }),
        });
        // Should NOT get 401 jwt-auth-error
        expect(response.status).not.toBe(401);
        const body = await response.text();
        expect(body).not.toContain("jwt-auth-error");
      } finally {
        server.close();
      }
    });
  });
});
