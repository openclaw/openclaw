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
  dns: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  prepareEffect: undefined as (() => Promise<void>) | undefined,
  fetch: async (_url: string, _init: RequestInit): Promise<Response> => new Response("{}"),
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureChannelReadAuthority: () => undefined,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      return {
        ...authority,
        initiate: async <T>(effect: () => T | Promise<T>) => {
          await boundary.prepareEffect?.();
          return authority.initiate(effect);
        },
      };
    },
  };
});
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({ parseMediaContentLength: Number }));
vi.mock("openclaw/plugin-sdk/response-limit-runtime", () => ({
  readResponseWithLimit: async (response: Response) => {
    const bytes = Buffer.from(await response.arrayBuffer());
    await boundary.afterRead?.();
    return bytes;
  },
}));
vi.mock("openclaw/plugin-sdk/extension-shared", () => ({
  buildTimeoutAbortSignal: ({ signal }: { signal?: AbortSignal }) => ({
    signal,
    cleanup() {},
  }),
}));
vi.mock("openclaw/plugin-sdk/ssrf-dispatcher", () => ({
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
}));
vi.mock("openclaw/plugin-sdk/runtime-fetch", () => ({
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
    dns: undefined,
    afterRead: undefined,
    prepareEffect: undefined,
    fetch: async () => new Response("{}"),
  }),
);

test.each([
  { stage: "DNS", dispatches: 0, stamps: 0, closed: 1 },
  { stage: "wire guard", dispatches: 0, stamps: 1, closed: 1 },
  { stage: "response read", dispatches: 1, stamps: 1, closed: 1 },
  { stage: "redirect DNS", dispatches: 1, stamps: 1, closed: 2 },
  { stage: "effect preparation", dispatches: 0, stamps: 1, closed: 1 },
  { stage: "redirect effect preparation", dispatches: 1, stamps: 2, closed: 2 },
])("revoked authority at $stage preserves dispatch custody", async (expected) => {
  let current = true;
  let stamps = 0;
  let dns = 0;
  let preparations = 0;
  const revoked = new Error("request owner revoked");
  boundary.prepareEffect = async () => {
    if (
      ++preparations ===
      (expected.stage === "effect preparation"
        ? 1
        : expected.stage === "redirect effect preparation"
          ? 2
          : 0)
    ) {
      throw revoked;
    }
  };
  boundary.dns = async () => {
    dns++;
    if (expected.stage === "DNS" || (expected.stage === "redirect DNS" && dns === 2)) {
      current = false;
    }
  };
  boundary.afterRead = async () => {
    if (expected.stage === "response read") {
      current = false;
    }
  };
  if (expected.stage.startsWith("redirect")) {
    boundary.fetch = async () =>
      new Response(null, { status: 307, headers: { location: "/next" } });
  }
  const fetch = createMatrixGuardedFetch({
    captureRequestAuthority: () => () => {
      if (!current) {
        throw revoked;
      }
    },
    beforeRequest: async () => {
      stamps++;
      await Promise.resolve();
      if (expected.stage === "wire guard") {
        current = false;
      }
    },
  });
  await assert.rejects(fetch(url, init), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.equal(error instanceof PlatformMessageNotDispatchedError, expected.dispatches === 0);
    if (expected.dispatches === 0) {
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.cause, revoked);
    } else {
      assert.equal(error.cause, revoked);
    }
    return true;
  });
  assert.equal(stamps, expected.stamps);
  assert.equal(boundary.dispatched.length, expected.dispatches);
  assert.equal(boundary.closed, expected.closed);
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

test.each([false, true])(
  "preserves transport failure identity after redirect=%s",
  async (redirect) => {
    const failure = new Error("transport disconnected");
    let requests = 0;
    boundary.fetch = async () => {
      if (redirect && ++requests === 1) {
        return new Response(null, { status: 307, headers: { location: "/next" } });
      }
      throw failure;
    };
    await assert.rejects(createMatrixGuardedFetch({})(url, init), (error) => error === failure);
    assert.equal(boundary.dispatched.length, redirect ? 2 : 1);
  },
);

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
