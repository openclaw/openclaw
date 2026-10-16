import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:http");
  vi.doUnmock("../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts");
  vi.doUnmock("./crabline-transport.ts");
  vi.doUnmock("./gateway-child.ts");
  vi.resetModules();
});

it.each(["transport", "gateway-cleanup", "gateway-start", "restart-gateway-cleanup"] as const)(
  "settles the automation provider after a %s failure",
  async (failure) => {
    const originalError = new Error("fixture acquisition failed");
    const cleanupError = new Error("Gateway cleanup failed");
    const cleanupFails = failure.endsWith("gateway-cleanup");
    const servers: Server[] = [];
    const stopped: string[] = [];
    const bodies = new Map<string, () => Promise<void>>();
    const register = (name: string, _options: unknown, body: () => Promise<void>) =>
      bodies.set(name, body);
    vi.doMock("vitest", async (importOriginal) => ({
      ...(await importOriginal<typeof import("vitest")>()),
      it: Object.assign(register, { skipIf: () => register }),
    }));
    vi.doMock("node:http", async (importOriginal) => {
      const http = await importOriginal<typeof import("node:http")>();
      return {
        ...http,
        createServer: (...args: Parameters<typeof http.createServer>) => {
          const server = http.createServer(...args);
          servers.push(server);
          server.once("close", () => stopped.push("provider"));
          return server;
        },
      };
    });
    vi.doMock(
      "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts",
      async (importOriginal) => ({
        ...(await importOriginal<
          typeof import("../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts")
        >()),
        createControlUiE2eSuite: () => ({
          artifactDir: ".artifacts/automation-cleanup",
          server: { baseUrl: "http://127.0.0.1:43210" },
          define: (body: () => void) => body(),
        }),
      }),
    );
    const start = vi.fn(async () => {
      throw originalError;
    });
    vi.doMock("./gateway-child.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./gateway-child.ts")>()),
      createQaGatewayChild: () => ({
        start,
        stop: async () => {
          stopped.push("gateway");
          if (cleanupFails) {
            throw cleanupError;
          }
          return { errors: [] };
        },
      }),
    }));
    vi.doMock("./crabline-transport.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./crabline-transport.ts")>()),
      createQaCrablineTransportAdapter: async () => {
        expect(servers).toHaveLength(1);
        expect(servers[0]?.listening).toBe(true);
        if (failure !== "gateway-start") {
          throw originalError;
        }
        return {
          cleanupAfterGatewayStop: async () => {
            stopped.push("transport");
          },
        };
      },
    }));
    try {
      await import("./control-ui-automation-management.real-gateway.e2e.test.ts");
      const body = bodies.get(
        failure === "restart-gateway-cleanup"
          ? "an ordinary Control UI turn creates a disabled automation after its Gateway is replaced"
          : "configured owners and admin chat manage a Telegram-created job while a non-owner cannot",
      );
      expect(body).toBeDefined();
      const result = body!();
      if (cleanupFails) {
        await expect(result).rejects.toMatchObject({ errors: [originalError, cleanupError] });
      } else {
        await expect(result).rejects.toBe(originalError);
      }
      expect(start).toHaveBeenCalledTimes(
        failure === "gateway-start" || failure === "restart-gateway-cleanup" ? 1 : 0,
      );
      expect(stopped).toEqual(
        failure === "gateway-start"
          ? ["gateway", "transport", "provider"]
          : ["gateway", "provider"],
      );
      expect(servers[0]?.listening).toBe(false);
    } finally {
      // Keep the regression itself settled when run against the leaking implementation.
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    }
  },
);
