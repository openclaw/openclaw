import assert from "node:assert/strict";
import test from "node:test";
import { invokeDispatchAction } from "../src/bridge.mjs";

test("invokeDispatchAction forwards W3C traceparent and tracestate for read tool", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push(init?.headers ?? {});
    return new Response(
      JSON.stringify({
        ok: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await invokeDispatchAction({
    baseUrl: "http://dispatch-api.internal",
    toolName: "ticket.get",
    actorId: "dispatcher-trace-test",
    actorRole: "dispatcher",
    actorType: "AGENT",
    ticketId: "51000000-0000-4000-8000-000000000001",
    requestId: "41000000-0000-4000-8000-000000000001",
    correlationId: "corr-traceparent-test",
    traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01",
    traceState: "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
    fetchImpl: fakeFetch,
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].traceparent, "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01");
  assert.equal(captured[0].tracestate, "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");
  assert.equal(captured[0]["x-trace-id"], undefined);
});

test("invokeDispatchAction forwards W3C traceparent and tracestate for mutating tool", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push(init?.headers ?? {});
    return new Response(
      JSON.stringify({
        ok: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await invokeDispatchAction({
    baseUrl: "http://dispatch-api.internal",
    toolName: "ticket.create",
    actorId: "dispatcher-trace-test",
    actorRole: "dispatcher",
    actorType: "AGENT",
    requestId: "41000000-0000-4000-8000-000000000003",
    correlationId: "corr-traceparent-mutate-test",
    traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01",
    traceState: "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
    payload: {
      account_id: "51000000-0000-4000-8000-000000000001",
      site_id: "51000000-0000-4000-8000-000000000002",
      summary: "Trace test ticket",
    },
    fetchImpl: fakeFetch,
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].traceparent, "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01");
  assert.equal(captured[0].tracestate, "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");
  assert.equal(captured[0]["x-trace-id"], undefined);
});

test("invokeDispatchAction falls back to legacy x-trace-id header", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push(init?.headers ?? {});
    return new Response(
      JSON.stringify({
        ok: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await invokeDispatchAction({
    baseUrl: "http://dispatch-api.internal",
    toolName: "ticket.get",
    actorId: "dispatcher-trace-test",
    actorRole: "dispatcher",
    actorType: "AGENT",
    ticketId: "51000000-0000-4000-8000-000000000002",
    requestId: "41000000-0000-4000-8000-000000000002",
    correlationId: "corr-trace-legacy-test",
    traceId: "legacy-trace-id",
    fetchImpl: fakeFetch,
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]["x-trace-id"], "legacy-trace-id");
  assert.equal(captured[0].traceparent, undefined);
  assert.equal(captured[0].tracestate, undefined);
});

test("invokeDispatchAction works without trace headers", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push(init?.headers ?? {});
    return new Response(
      JSON.stringify({
        ok: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await invokeDispatchAction({
    baseUrl: "http://dispatch-api.internal",
    toolName: "ticket.get",
    actorId: "dispatcher-trace-test",
    actorRole: "dispatcher",
    actorType: "AGENT",
    ticketId: "51000000-0000-4000-8000-000000000001",
    fetchImpl: fakeFetch,
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]["x-trace-id"], undefined);
  assert.equal(captured[0].traceparent, undefined);
  assert.equal(captured[0].tracestate, undefined);
});
