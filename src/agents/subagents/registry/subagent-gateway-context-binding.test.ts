import { expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver as bindContext,
  getGatewayContextResolver as getContext,
  getSharedGatewayContextResolver as sharedContext,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";

it.each(["distinct", "first-unbound", "second-unbound"])(
  "rejects a %s settle batch without losing its binding",
  (mode) => {
    const first = {};
    const second = {};
    const firstContext = { owner: "gateway-a" } as never;
    const secondContext = { owner: "gateway-b" } as never;
    bindContext(first, mode === "first-unbound" ? undefined : () => firstContext);
    bindContext(second, mode === "second-unbound" ? undefined : () => secondContext);

    const shared = sharedContext([first, second]);
    expect(shared).toBeTypeOf("function");
    expect(() => shared?.()).toThrow("incompatible Gateway");
  },
);

it.each([
  { retired: 0, closure: "closed" },
  { retired: 1, closure: "closed" },
  { retired: 1, closure: "replaced" },
  { retired: 1, closure: "throwing" },
])("rechecks caller $retired after its source is $closure", async ({ retired, closure }) => {
  const context = {} as GatewayRequestContext;
  const replacement = {} as GatewayRequestContext;
  const sources: Array<GatewayRequestContext | undefined> = [context, context];
  const owners = [{}, {}];
  let throwing = false;
  for (const [index, owner] of owners.entries()) {
    const resolver = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        gatewayContextResolver: () => {
          if (throwing && index === retired) {
            throw new Error("source closed");
          }
          return sources[index];
        },
      },
      () => getGatewayToolCallerIdentity()?.gatewayContextResolver,
    );
    bindContext(owner, resolver);
  }
  expect(getContext(owners[0]!)).not.toBe(getContext(owners[1]!));
  const shared = sharedContext(owners);
  expect(shared?.()).toBe(context);
  // Rebinding a row cannot retarget a composition already captured by delivery.
  bindContext(owners[retired]!, () => replacement);
  expect(shared?.()).toBe(context);
  throwing = closure === "throwing";
  sources[retired] = closure === "replaced" ? replacement : undefined;
  expect(shared?.()).toBeUndefined();
});

it("preserves a shared owner and leaves wholly unbound batches unbound", () => {
  const owners = [{}, {}];
  const context = {} as GatewayRequestContext;
  const resolver = vi.fn(() => context);
  expect(sharedContext([])).toBeUndefined();
  expect(sharedContext(owners)).toBeUndefined();
  owners.forEach((owner) => bindContext(owner, resolver));
  const shared = sharedContext(owners);
  expect(shared?.()).toBe(context);
  resolver.mockImplementation(() => {
    throw new Error("source closed");
  });
  expect(shared?.()).toBeUndefined();
});
