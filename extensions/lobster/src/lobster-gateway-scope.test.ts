import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEmbeddedRouteRunsInGateway,
  authorizeSavedAnswerForCaller,
} from "./lobster-gateway-scope.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: vi.fn(),
}));
const scopeMock = vi.mocked(getPluginRuntimeGatewayRequestScope);
const base = { isWebchatConnect: () => false };
beforeEach(() => {
  scopeMock.mockReset();
});

describe("lobster gateway scope", () => {
  it("refuses the embedded route outside a gateway request scope", () => {
    expect(() => assertEmbeddedRouteRunsInGateway()).toThrow("gateway request scope");
  });
  it("refuses a saved answer without a request scope", async () => {
    await expect(authorizeSavedAnswerForCaller()).rejects.toThrow("gateway request scope");
  });
  it("refuses a scope that has no authority checker", async () => {
    scopeMock.mockReturnValue(base);
    await expect(authorizeSavedAnswerForCaller()).rejects.toThrow("authority checker");
  });
  it("accepts the host's current-authority callback", async () => {
    const current = vi.fn(() => true);
    scopeMock.mockReturnValue({ ...base, hasCurrentClientAuthority: current });
    await expect(authorizeSavedAnswerForCaller()).resolves.toBeUndefined();
    expect(current).toHaveBeenCalled();
  });
  it("rejects authority invalidated by the host", async () => {
    scopeMock.mockReturnValue({ ...base, hasCurrentClientAuthority: () => false });
    await expect(authorizeSavedAnswerForCaller()).rejects.toThrow("no longer current");
  });
  it("propagates a revoked grant from revalidation", async () => {
    const denied = new Error("grant revoked");
    scopeMock.mockReturnValue({
      ...base,
      revalidate: async () => {
        throw denied;
      },
    });
    await expect(authorizeSavedAnswerForCaller()).rejects.toBe(denied);
  });
  it("accepts successful host revalidation", async () => {
    const revalidate = vi.fn(async () => {});
    scopeMock.mockReturnValue({ ...base, revalidate });
    await expect(authorizeSavedAnswerForCaller()).resolves.toBeUndefined();
    expect(revalidate).toHaveBeenCalledOnce();
  });
  it("checks authority again after awaited revalidation", async () => {
    let current = true;
    scopeMock.mockReturnValue({
      ...base,
      hasCurrentClientAuthority: () => current,
      revalidate: async () => {
        current = false;
      },
    });
    await expect(authorizeSavedAnswerForCaller()).rejects.toThrow("no longer current");
  });
  it("refuses an aborted request even when callbacks return success", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request ended"));
    scopeMock.mockReturnValue({
      ...base,
      signal: controller.signal,
      hasCurrentClientAuthority: () => true,
    });
    await expect(authorizeSavedAnswerForCaller()).rejects.toThrow("request ended");
  });
  it("checks cancellation after awaited revalidation", async () => {
    const controller = new AbortController();
    scopeMock.mockReturnValue({
      ...base,
      signal: controller.signal,
      revalidate: async () => {
        controller.abort(new Error("request ended"));
      },
    });
    await expect(authorizeSavedAnswerForCaller()).rejects.toThrow("request ended");
  });
});
