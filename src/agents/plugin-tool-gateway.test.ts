import { afterEach, expect, it, vi } from "vitest";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as publication from "../gateway/workspace-publication-binding.js";
import { preparePluginToolGatewayCapability } from "./plugin-tool-gateway.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as transport from "./tools/in-process-gateway.js";

afterEach(() => vi.restoreAllMocks());

it("routes readiness through the installed publisher and retains its authority checks", async () => {
  const context = createContext();
  vi.spyOn(transport, "getInProcessGatewayToolContext").mockReturnValue(context);
  let current = true;
  // Isolate bridge admission from publication storage and RPC execution.
  const assertProvider = () => {
    if (!current) {
      throw new Error("Publisher retired");
    }
  };
  vi.spyOn(publication, "captureWorkspacePublicationProvider").mockImplementation(
    (_context, pluginId) => (pluginId === "publisher" ? assertProvider : undefined),
  );
  const dispatch = vi.spyOn(transport, "callInProcessGatewayTool").mockResolvedValue({
    custody: { state: "unbound" },
  });
  const caller = { agentId: "main", sessionKey: "agent:main:readiness" };
  const bind = preparePluginToolGatewayCapability(undefined, caller);
  const gateway = bind(() => {}, undefined, [], "publisher");
  const observe = () =>
    gateway.call("sessions.github.readiness", { sessionKey: caller.sessionKey });
  await withGatewayToolCallerIdentity(caller, async () => {
    await expect(observe()).resolves.toEqual({ custody: { state: "unbound" } });
    await expect(gateway.call("config.set", {})).rejects.toThrow("owned Gateway method");
    await expect(
      bind(() => {}, undefined, [], "other-plugin").call("sessions.github.readiness", {}),
    ).rejects.toThrow("owned Gateway method");
    current = false;
    await expect(observe()).rejects.toThrow("Publisher retired");
  });
  expect(dispatch).toHaveBeenCalledOnce();
});
