import type * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  resolveFeishuWebhookAnomalyDefaultsForTest,
  resolveFeishuWebhookRateLimitDefaultsForTest,
  httpServers,
  stopFeishuMonitorState,
} from "./monitor.state.js";

describe("feishu monitor state defaults", () => {
  it("falls back to hard defaults when sdk defaults are missing", () => {
    expect(resolveFeishuWebhookRateLimitDefaultsForTest(undefined)).toEqual({
      windowMs: 60_000,
      maxRequests: 120,
      maxTrackedKeys: 4_096,
    });
    expect(resolveFeishuWebhookAnomalyDefaultsForTest(undefined)).toEqual({
      maxTrackedKeys: 4_096,
      ttlMs: 21_600_000,
      logEvery: 25,
    });
  });

  it("keeps valid sdk values and repairs invalid fields", () => {
    expect(
      resolveFeishuWebhookRateLimitDefaultsForTest({
        windowMs: 45_000,
        maxRequests: 0,
        maxTrackedKeys: -1,
      }),
    ).toEqual({
      windowMs: 45_000,
      maxRequests: 120,
      maxTrackedKeys: 4_096,
    });

    expect(
      resolveFeishuWebhookAnomalyDefaultsForTest({
        maxTrackedKeys: 2048,
        ttlMs: Number.NaN,
        logEvery: 10,
      }),
    ).toEqual({
      maxTrackedKeys: 2048,
      ttlMs: 21_600_000,
      logEvery: 10,
    });
  });
});

describe("feishu monitor state cleanup", () => {
  function mockServer(): http.Server {
    return {
      close: vi.fn(),
      closeAllConnections: vi.fn(),
    } as unknown as http.Server;
  }

  it("calls closeAllConnections before close for a single account", () => {
    const server = mockServer();
    httpServers.set("test-account", server);

    stopFeishuMonitorState("test-account");

    expect(server.closeAllConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    expect(httpServers.has("test-account")).toBe(false);
  });

  it("calls closeAllConnections on all servers when no accountId given", () => {
    const server1 = mockServer();
    const server2 = mockServer();
    httpServers.set("a", server1);
    httpServers.set("b", server2);

    stopFeishuMonitorState();

    expect(server1.closeAllConnections).toHaveBeenCalled();
    expect(server1.close).toHaveBeenCalled();
    expect(server2.closeAllConnections).toHaveBeenCalled();
    expect(server2.close).toHaveBeenCalled();
    expect(httpServers.size).toBe(0);
  });
});
