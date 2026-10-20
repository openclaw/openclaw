import { expect, it } from "vitest";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver as bindContext,
  getGatewayContextResolver as getContext,
  getSharedGatewayContextResolver as sharedContext,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";

it("keeps successor routing private and excludes restored rows", () => {
  const context = { owner: "gateway-a" } as never;
  const resolver = () => context;
  const source = createSubagentRunRecord({ runId: "run-source" });
  const successor = createSubagentRunRecord({ runId: "run-successor" });
  const restored = structuredClone(source);

  bindContext(source, resolver);
  bindContext(successor, getContext(source));

  expect(getContext(successor)?.()).toBe(context);
  expect(getContext(restored)).toBeUndefined();
});

it.each(["distinct", "first-unbound", "second-unbound"])(
  "rejects a %s settle batch without losing its binding",
  (mode) => {
    const first = createSubagentRunRecord({ runId: "run-first" });
    const second = createSubagentRunRecord({ runId: "run-second" });
    const firstContext = { owner: "gateway-a" } as never;
    const secondContext = { owner: "gateway-b" } as never;
    if (mode !== "first-unbound") {
      bindContext(first, () => firstContext);
    }
    if (mode !== "second-unbound") {
      bindContext(second, () => secondContext);
    }

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
  const first = {};
  const second = {};
  const context = {} as GatewayRequestContext;
  let closed = false;
  const resolver = () => {
    if (closed) {
      throw new Error("source closed");
    }
    return context;
  };
  expect(sharedContext([])).toBeUndefined();
  expect(sharedContext([first, second])).toBeUndefined();
  bindContext(first, resolver);
  bindContext(second, resolver);
  const shared = sharedContext([first, second]);
  expect(shared?.()).toBe(context);
  closed = true;
  expect(shared?.()).toBeUndefined();
});
