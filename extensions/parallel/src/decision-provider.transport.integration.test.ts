import { createServer, type IncomingHttpHeaders } from "node:http";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { buildParallelDecisionProvider } from "./decision-provider.js";
// Prepare module loading before measuring the network/authority boundary.
import "./decision-provider.runtime.js";

const dns = vi.hoisted(() => {
  const state: { started?: () => void; resume: Promise<void> } = { resume: Promise.resolve() };
  return state;
});
// mock-isolation: only external DNS is held to model revocation during preparation.
// The provider, HTTP guard, dispatcher, beforeRequest hook, and socket are real.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async (hostname: string, options: { all: true }) => {
      if (hostname !== "parallel-authority.example") {
        return actual.lookup(hostname, options);
      }
      dns.started?.();
      await dns.resume;
      return [{ address: "127.0.0.1", family: 4 }];
    },
  };
});

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "Synthetic public evidence" },
  questions: { q: { type: "boolean", instructions: "Does the evidence match?" } },
};

async function fixture(hostname = "127.0.0.1") {
  const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  let connections = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ headers: request.headers, body });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          mode: "fast",
          decision_id: "decisions_synthetic",
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 3, output_tokens: 0 },
          citations: [],
        }),
      );
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listenOnLoopback(server);
  onTestFinished(async () => {
    // The fixture owns its server sockets, not the runtime-owned provider pool.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
  const baseUrl = "http://" + hostname + ":" + port + "/v1";
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const context: DecisionProviderContextV2 = {
    model: {
      provider: "parallel",
      id: "decisions-fast",
      name: "Parallel: Decisions Fast",
      baseUrl,
    },
    config: {
      models: {
        providers: { parallel: { baseUrl, models: [], request: { allowPrivateNetwork: true } } },
      },
    },
    auth: { apiKey: "synthetic-original-provider-key", mode: "api-key" },
    signal: controller.signal,
    deadlineMonotonicMs: performance.now() + 60_000,
    isAdmissible: () => true,
  };
  return { context, requests, connections: () => connections };
}

it.each(["provider-default", "replacement"])(
  "dispatches a real native request with only %s authentication",
  async (mode) => {
    const { context, requests } = await fixture();
    if (mode === "replacement") {
      context.model.headers = { "X-Gateway-Token": "synthetic-prepared-replacement" };
      context.config.models!.providers!.parallel!.request!.auth = {
        mode: "header",
        headerName: "X-Gateway-Token",
        value: "synthetic-prepared-replacement",
      };
    }
    expect(await buildParallelDecisionProvider().evaluate(batch, context)).toMatchObject({
      status: "ok",
      result: { answers: { q: { probabilityTrue: 0.9 } } },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["x-api-key"]).toBe(
      mode === "replacement" ? undefined : "synthetic-original-provider-key",
    );
    expect(requests[0]!.headers["x-gateway-token"]).toBe(
      mode === "replacement" ? "synthetic-prepared-replacement" : undefined,
    );
    expect(JSON.parse(requests[0]!.body)).toEqual({
      mode: "fast",
      state: "Synthetic public evidence",
      questions: { q: { type: "noul", instructions: "Does the evidence match?" } },
    });
  },
);

it.each(["caller", "credential"])(
  "rejects revoked %s authority after DNS and before socket I/O",
  async (revoked) => {
    const { context, requests, connections } = await fixture("parallel-authority.example");
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    dns.resume = new Promise<void>((resolve) => {
      resume = resolve;
    });
    dns.started = started;
    onTestFinished(resume);
    let callerCurrent = true;
    let credentialCurrent = true;
    const pending = buildParallelDecisionProvider().evaluate(batch, {
      ...context,
      isAdmissible: () => callerCurrent && credentialCurrent,
    });
    await lookupStarted;
    if (revoked === "caller") {
      callerCurrent = false;
    } else {
      credentialCurrent = false;
    }
    resume();
    expect(await pending).toEqual({ status: "unavailable", reason: "transport" });
    expect(requests).toHaveLength(0);
    expect(connections()).toBe(0);
  },
);

it.each(["resolved-model", "global-defaults"])(
  "rejects unsupported controls from %s before socket I/O",
  async (layer) => {
    const { context, requests, connections } = await fixture();
    if (layer === "resolved-model") {
      context.model.params = { temperature: 0 };
    } else {
      context.config.agents = { defaults: { params: { temperature: 0 } } };
    }
    expect(await buildParallelDecisionProvider().evaluate(batch, context)).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(requests).toHaveLength(0);
    expect(connections()).toBe(0);
  },
);
