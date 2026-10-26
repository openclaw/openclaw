import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

function mockModule(id: string, overrides: Record<string, unknown>) {
  vi.doMock(id, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ...overrides,
  }));
}

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:http");
  vi.doUnmock("../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts");
  vi.doUnmock("./crabline-transport.ts");
  vi.doUnmock("./gateway-child.ts");
  vi.resetModules();
});

it.each([
  ["transport", 0, ["gateway", "provider"]],
  ["gateway-cleanup", 0, ["gateway", "provider"]],
  ["gateway-start", 1, ["gateway", "transport", "provider"]],
  ["restart-gateway-cleanup", 1, ["gateway", "provider"]],
] as const)(
  "settles the automation provider after a %s failure",
  async (failure, startCount, expectedStops) => {
    const originalError = new Error("fixture acquisition failed");
    const cleanupError = new Error("Gateway cleanup failed");
    const cleanupFails = failure.endsWith("gateway-cleanup");
    const servers: Server[] = [];
    const stopped: string[] = [];
    const bodies = new Map<string, () => Promise<void>>();
    const register = (name: string, _options: unknown, body: () => Promise<void>) =>
      bodies.set(name, body);
    mockModule("vitest", {
      it: Object.assign(register, { skipIf: () => register }),
    });
    mockModule("node:http", {
      createServer: (...args: Parameters<typeof createServer>) => {
        const server = createServer(...args);
        servers.push(server);
        server.once("close", () => stopped.push("provider"));
        return server;
      },
    });
    mockModule("../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts", {
      createControlUiE2eSuite: () => ({
        artifactDir: ".artifacts/automation-cleanup",
        server: { baseUrl: "http://127.0.0.1:43210" },
        define: (body: () => void) => body(),
      }),
    });
    const start = vi.fn<() => Promise<never>>().mockRejectedValue(originalError);
    mockModule("./gateway-child.ts", {
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
    });
    mockModule("./crabline-transport.ts", {
      createQaCrablineTransportAdapter: async () => {
        expect(servers).toMatchObject([{ listening: true }]);
        if (failure !== "gateway-start") {
          throw originalError;
        }
        return {
          cleanupAfterGatewayStop: async () => {
            stopped.push("transport");
          },
        };
      },
    });
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
      expect(start).toHaveBeenCalledTimes(startCount);
      expect(stopped).toEqual(expectedStops);
      expect(servers[0]?.listening).toBe(false);
    } finally {
      // Keep the regression itself settled when run against the leaking implementation.
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
  },
);
