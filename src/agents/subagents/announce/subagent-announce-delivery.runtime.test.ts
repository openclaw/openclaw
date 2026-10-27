import { describe, expect, it, vi } from "vitest";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  return createGatewayContext(
    Object.entries(handlers).map(([name, handler]) => [name, WRITE_SCOPE, "test", handler]),
  );
}

describe("subagent announce Gateway instance dispatch", () => {
  it("delivers through a lifecycle-fenced instance resolver scope", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "scoped-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "scoped-announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          dispatchGatewayMethodInProcess(
            "agent",
            {
              message: "Process one completed child result.",
              idempotencyKey,
            },
            {
              expectFinal: true,
              forceSyntheticClient: true,
            },
          ),
      ),
    ).resolves.toEqual({
      runId: "scoped-announce-run",
      status: "ok",
      summary: "delivered",
    });
  });
  it("rejects a nested-wake owner retired after selection before either Gateway dispatches", async () => {
    const retiredAgent = vi.fn(({ respond }) => respond(true, { raw: true }));
    const retiredContext = createContext({ agent: retiredAgent });
    const replacementAgent = vi.fn(({ respond }) => respond(true, { raw: true }));
    const replacementContext = createContext({ agent: replacementAgent });
    const resolveGatewayContext = vi
      .fn<() => GatewayRequestContext | undefined>()
      .mockReturnValueOnce(retiredContext)
      .mockReturnValue(undefined);

    await expect(
      withPluginRuntimeGatewayContextResolver(
        () => replacementContext,
        () =>
          dispatchGatewayMethodInProcess(
            "agent",
            {
              message: "Continue after nested descendants settle.",
              idempotencyKey: "retired-nested-wake",
            },
            {
              forceSyntheticClient: true,
              resolveGatewayContext,
            },
          ),
      ),
    ).rejects.toThrow("current gateway instance binding");
    expect(resolveGatewayContext).toHaveBeenCalledTimes(2);
    expect(retiredAgent).not.toHaveBeenCalled();
    expect(replacementAgent).not.toHaveBeenCalled();
  });
});
