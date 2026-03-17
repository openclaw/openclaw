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
  it("calls closeAllConnections before close for a single account", () => {
    const callOrder: string[] = [];
    const server = {
      close: vi.fn(() => callOrder.push("close")),
      closeAllConnections: vi.fn(() => callOrder.push("closeAllConnections")),
    } as unknown as http.Server;
    httpServers.set("test-account", server);

    stopFeishuMonitorState("test-account");

    expect(callOrder).toEqual(["closeAllConnections", "close"]);
    expect(httpServers.has("test-account")).toBe(false);
  });

  it("calls closeAllConnections on all servers when no accountId given", () => {
    const callOrder: string[] = [];
    const server1 = {
      close: vi.fn(() => callOrder.push("s1:close")),
      closeAllConnections: vi.fn(() => callOrder.push("s1:closeAll")),
    } as unknown as http.Server;
    const server2 = {
      close: vi.fn(() => callOrder.push("s2:close")),
      closeAllConnections: vi.fn(() => callOrder.push("s2:closeAll")),
    } as unknown as http.Server;
    httpServers.set("a", server1);
    httpServers.set("b", server2);

    stopFeishuMonitorState();

    expect(callOrder).toEqual(["s1:closeAll", "s1:close", "s2:closeAll", "s2:close"]);
    expect(httpServers.size).toBe(0);
  });
});
