import http, { Agent, request } from "node:http";
import { expect, onTestFinished, vi } from "vitest";
import type { InvokeNativeHookRelayParams } from "./native-hook-relay-types.js";

type FixtureEndpoint = { hostname: "127.0.0.1"; port: number };

// Declare only the owned loopback endpoint; never send these fixture requests to an ambient proxy.
export function useNativeHookFixtureHttpAgent(target: FixtureEndpoint): Agent {
  const globalAgent = http.globalAgent;
  const agent = new Agent();
  vi.spyOn(agent, "createConnection").mockImplementation((options, callback) => {
    expect(options.host).toBe(target.hostname);
    expect(Number(options.port)).toBe(target.port);
    return Agent.prototype.createConnection.call(agent, options, callback);
  });
  onTestFinished(() => {
    http.globalAgent = globalAgent;
    agent.destroy();
  });
  http.globalAgent = agent;
  return agent;
}

export function postNativeHookFixtureRequest(
  record: FixtureEndpoint & { token: string },
  payload: InvokeNativeHookRelayParams,
  rejectBeforePolicyEntry: (error: Error) => void,
) {
  const outgoing = request({
    agent: useNativeHookFixtureHttpAgent(record),
    host: record.hostname,
    port: record.port,
    method: "POST",
    path: "/invoke",
    headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" },
  });
  outgoing.on("error", rejectBeforePolicyEntry);
  outgoing.on("response", (response) => {
    response.resume();
    rejectBeforePolicyEntry(
      new Error(`Unexpected fixture response before policy entry: ${response.statusCode}`),
    );
  });
  outgoing.end(JSON.stringify(payload));
  return outgoing;
}
