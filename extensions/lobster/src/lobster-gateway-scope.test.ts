import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEmbeddedRouteRunsInGateway,
  authorizeCheckpointForCaller,
  authorizeSavedAnswerForCaller,
  describeCurrentCaller,
} from "./lobster-gateway-scope.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
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

describe("lobster checkpoint authority", () => {
  type Client = NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>["client"];
  function caller(scopes: string[], allowModelOverride = false, current = true) {
    scopeMock.mockReturnValue({
      ...base,
      hasCurrentClientAuthority: () => current,
      client: { connect: { scopes }, internal: { allowModelOverride } } as unknown as Client,
    });
  }
  const embedded = {
    version: 1 as const,
    stages: [{ provider: "embedded", command: "llm.invoke" }],
    caller: { agentId: "main", authority: ["operator.admin", "operator.write"] },
  };

  it("records the calling agent and the request's authority", () => {
    caller(["operator.write", "operator.admin", "operator.write"], true);
    expect(describeCurrentCaller(" main ")).toEqual({
      agentId: "main",
      authority: ["model-override", "operator.admin", "operator.write"],
    });
  });
  it("lets a checkpoint without LLM output resume outside a gateway request", async () => {
    await expect(
      authorizeCheckpointForCaller({ version: 1, stages: [] }, undefined),
    ).resolves.toBeUndefined();
  });
  it("treats an unrecorded checkpoint as a saved answer", async () => {
    await expect(authorizeCheckpointForCaller(undefined, "main")).rejects.toThrow(
      "gateway request scope",
    );
    caller(["operator.write"]);
    await expect(authorizeCheckpointForCaller(undefined, "main")).resolves.toBeUndefined();
  });
  it("re-checks current authority before stored remote output is consumed", async () => {
    const remote = { version: 1 as const, stages: [{ provider: "http", command: "llm.invoke" }] };
    caller(["operator.write"], false, false);
    await expect(authorizeCheckpointForCaller(remote, "main")).rejects.toThrow("no longer current");
  });
  it("resumes embedded output for the same agent holding the same authority", async () => {
    caller(["operator.write", "operator.admin", "operator.read"]);
    await expect(authorizeCheckpointForCaller(embedded, "main")).resolves.toBeUndefined();
  });
  it("refuses embedded output to another agent", async () => {
    caller(["operator.write", "operator.admin"]);
    await expect(authorizeCheckpointForCaller(embedded, "other")).rejects.toThrow(
      "produced for another agent",
    );
  });
  it("refuses embedded output to a caller that lost authority during the pause", async () => {
    caller(["operator.write", "operator.read"]);
    await expect(authorizeCheckpointForCaller(embedded, "main")).rejects.toThrow(
      "no longer holds operator.admin",
    );
  });
  it("refuses embedded output with no recorded producer", async () => {
    caller(["operator.write", "operator.admin"]);
    await expect(
      authorizeCheckpointForCaller({ version: 1, stages: embedded.stages }, "main"),
    ).rejects.toThrow("produced for another agent");
  });
});
