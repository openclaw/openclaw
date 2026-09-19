// Integrates per-wire completion ownership with the Matrix request authority lifecycle.
import assert from "node:assert/strict";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { beforeEach, test, vi } from "vitest";
import {
  MatrixMessageWireDispatchGuards,
  type MatrixMessageWireDispatch,
} from "./message-wire-dispatch.js";
import { createMatrixGuardedFetch } from "./transport.js";

const boundary = vi.hoisted(() => ({
  dispatched: [] as Array<[string, RequestInit]>,
  closed: 0,
  cleanups: 0,
  dns: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  fetch: async (_url: string, _init: RequestInit): Promise<Response> => new Response("{}"),
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  captureChannelReadAuthority: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({ parseMediaContentLength: Number }));
vi.mock("./read-response-with-limit.js", () => ({
  readResponseWithLimit: async (response: Response) => {
    const bytes = Buffer.from(await response.arrayBuffer());
    await boundary.afterRead?.();
    return bytes;
  },
}));
vi.mock("./transport-runtime-api.js", () => ({
  buildTimeoutAbortSignal: ({ signal }: { signal?: AbortSignal }) => ({
    signal,
    cleanup() {
      boundary.cleanups++;
    },
  }),
  closeDispatcher: async (dispatcher?: object) => {
    if (dispatcher) {
      boundary.closed++;
    }
  },
  createPinnedDispatcher: () => ({}),
  resolvePinnedHostnameWithPolicy: async () => {
    await boundary.dns?.();
    return {};
  },
  fetchWithRuntimeDispatcherOrMockedGlobal: async (url: string, init: RequestInit) => {
    boundary.dispatched.push([url, init]);
    return boundary.fetch(url, init);
  },
}));

const url =
  "https://matrix.example/_matrix/client/v3/rooms/%21room%3Aexample/send/m.room.message/txn-1";
const init = { method: "PUT", body: "{}" };
beforeEach(() =>
  Object.assign(boundary, {
    dispatched: [],
    closed: 0,
    cleanups: 0,
    dns: undefined,
    afterRead: undefined,
    fetch: async () => new Response("{}"),
  }),
);

test("wire owner revoked during DNS cannot dispatch", async () => {
  let current = true;
  boundary.dns = async () => {
    current = false;
  };
  const fetch = createMatrixGuardedFetch({
    beforeRequest: async () => {
      if (!current) {
        throw new Error("wire owner revoked");
      }
    },
  });
  await assert.rejects(fetch(url, init), /wire owner revoked/);
  assert.equal(boundary.dispatched.length, 0);
  assert.equal(boundary.closed, 1);
});

test("captured request authority is revalidated after an awaited wire guard", async () => {
  let current = true;
  const fetch = createMatrixGuardedFetch({
    captureRequestAuthority: () => () => {
      if (!current) {
        throw new Error("request owner revoked");
      }
    },
    beforeRequest: async () => {
      await Promise.resolve();
      current = false;
    },
  });
  await assert.rejects(fetch(url, init), /request owner revoked/);
  assert.equal(boundary.dispatched.length, 0);
  assert.equal(boundary.closed, 1);
});

test("client abort during wire guard prevents dispatch", async () => {
  const controller = new AbortController();
  const fetch = createMatrixGuardedFetch({
    signal: controller.signal,
    beforeRequest: async () => {
      await Promise.resolve();
      controller.abort(new Error("client stopped"));
    },
  });
  await assert.rejects(fetch(url, init), /client stopped/);
  assert.equal(boundary.dispatched.length, 0);
});

test("redirect rechecks original transaction through the canonical registry", async () => {
  const guards = new MatrixMessageWireDispatchGuards();
  const observed: MatrixMessageWireDispatch[] = [];
  boundary.fetch = async () =>
    new Response(null, { status: 307, headers: { location: "https://matrix.example/redirected" } });
  const fetch = createMatrixGuardedFetch({
    beforeRequest: (resource, request) => guards.beforeRequest(resource, request),
  });
  await assert.rejects(
    guards.run({
      transactionId: "txn-1",
      guard: async (dispatch) => {
        observed.push(dispatch);
        if (observed.length === 2) {
          throw new Error("redirect owner revoked");
        }
      },
      run: () => fetch(url, init),
    }),
    /redirect owner revoked/,
  );
  assert.equal(boundary.dispatched.length, 1);
  assert.equal(observed.length, 2);
  const firstDispatch = observed[0];
  assert.ok(firstDispatch);
  assert.equal(firstDispatch.transactionId, "txn-1");
  assert.deepEqual(observed[1], observed[0]);
  assert.equal(boundary.closed, 2);
  assert.equal(await guards.beforeRequest(url, init), undefined);
});

test("successful guarded redirect retains response and each-hop owner checks", async () => {
  let calls = 0;
  boundary.fetch = async () =>
    boundary.dispatched.length === 1
      ? new Response(null, { status: 307, headers: { location: "/final" } })
      : new Response('{"ok":true}');
  const fetch = createMatrixGuardedFetch({
    beforeRequest: async () => {
      calls++;
    },
  });
  const response = await fetch(url, init);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 2);
  assert.equal(boundary.dispatched.length, 2);
  assert.equal(boundary.closed, 2);
});

test("request authority remains enforced after response read", async () => {
  let current = true;
  boundary.afterRead = async () => {
    current = false;
  };
  const fetch = createMatrixGuardedFetch({
    captureRequestAuthority: () => () => {
      if (!current) {
        throw new Error("response owner revoked");
      }
    },
    beforeRequest: async () => {},
  });
  await assert.rejects(fetch(url, init), /response owner revoked/);
  assert.equal(boundary.closed, 1);
});

test("per-request abort remains effective with a client signal", async () => {
  const client = new AbortController();
  const request = new AbortController();
  const fetch = createMatrixGuardedFetch({
    signal: client.signal,
    beforeRequest: async () => {
      request.abort(new Error("request stopped"));
    },
  });
  await assert.rejects(fetch(url, { ...init, signal: request.signal }), /request stopped/);
  assert.equal(boundary.dispatched.length, 0);
});

test("authority loss during DNS does not stamp persistent dispatch", async () => {
  let current = true,
    stamps = 0;
  boundary.dns = async () => {
    await Promise.resolve();
    current = false;
  };
  const fetch = createMatrixGuardedFetch({
    captureRequestAuthority: () => () => {
      if (!current) {
        throw new Error("stale authority");
      }
    },
    beforeRequest: async () => {
      stamps++;
    },
  });
  await assert.rejects(fetch(url, init), /stale authority/);
  assert.equal(stamps, 0);
  assert.equal(boundary.dispatched.length, 0);
  assert.equal(boundary.closed, 1);
});
test("abort during DNS does not stamp persistent dispatch", async () => {
  const client = new AbortController();
  let stamps = 0;
  boundary.dns = async () => {
    await Promise.resolve();
    client.abort(new Error("client stopped"));
  };
  const fetch = createMatrixGuardedFetch({
    signal: client.signal,
    beforeRequest: async () => {
      stamps++;
    },
  });
  await assert.rejects(fetch(url, init), /client stopped/);
  assert.equal(stamps, 0);
  assert.equal(boundary.dispatched.length, 0);
  assert.equal(boundary.closed, 1);
});
test("redirect DNS revocation does not stamp a second dispatch", async () => {
  let current = true,
    stamps = 0,
    dns = 0;
  boundary.dns = async () => {
    if (++dns === 2) {
      current = false;
    }
  };
  boundary.fetch = async () => new Response(null, { status: 307, headers: { location: "/next" } });
  const fetch = createMatrixGuardedFetch({
    captureRequestAuthority: () => () => {
      if (!current) {
        throw new Error("stale authority");
      }
    },
    beforeRequest: async () => {
      stamps++;
    },
  });
  await assert.rejects(fetch(url, init), /stale authority/);
  assert.equal(stamps, 1);
  assert.equal(boundary.dispatched.length, 1);
  assert.equal(boundary.closed, 2);
});

test("durable callback abort before first fetch carries proven-unsent custody", async () => {
  const abort = new AbortController();
  let durableMarker = false;
  const send = createMatrixGuardedFetch({
    signal: abort.signal,
    beforeRequest: async () => {
      durableMarker = true;
      await Promise.resolve();
      abort.abort(new Error("stopped after durable marker"));
    },
  });
  await assert.rejects(
    send(url, init),
    (error: unknown) => error instanceof PlatformMessageNotDispatchedError && error.retryable,
  );
  assert.equal(durableMarker, true);
  assert.equal(boundary.dispatched.length, 0);
});

test("a redirect rejection cannot erase an earlier dispatch", async () => {
  let guards = 0;
  boundary.fetch = async () =>
    new Response(null, {
      status: 307,
      headers: { location: "/redirected" },
    });
  const send = createMatrixGuardedFetch({
    beforeRequest: async () => {
      if (++guards === 2) {
        throw new PlatformMessageNotDispatchedError("second hop rejected", { cause: undefined });
      }
    },
  });
  await assert.rejects(send(url, init), AggregateError);
  assert.equal(boundary.dispatched.length, 1);
});
