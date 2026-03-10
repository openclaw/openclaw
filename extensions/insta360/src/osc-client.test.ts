import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OscClient } from "./osc-client.js";

const BASE_URL = "http://192.168.1.1";

function makeOkResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OscClient", () => {
  describe("getInfo", () => {
    it("sends GET to /osc/info with correct headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeOkResponse({ model: "X4" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.getInfo();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/osc/info`);
      expect(opts.method).toBe("GET");
      expect(opts.headers["Content-Type"]).toBe("application/json;charset=utf-8");
      expect(opts.headers["Accept"]).toBe("application/json");
      expect(opts.headers["X-XSRF-Protected"]).toBe("1");
      expect(result).toEqual({ model: "X4" });
    });
  });

  describe("getState", () => {
    it("sends POST to /osc/state", async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeOkResponse({ state: { battery: 80 } }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.getState();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/osc/state`);
      expect(opts.method).toBe("POST");
      expect(result).toEqual({ state: { battery: 80 } });
    });
  });

  describe("execute", () => {
    it("sends POST to /osc/commands/execute with correct body", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeOkResponse({ name: "camera.takePicture", state: "done" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.execute("camera.takePicture", { mode: "normal" });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/osc/commands/execute`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({ name: "camera.takePicture", parameters: { mode: "normal" } });
      expect(result).toEqual({ name: "camera.takePicture", state: "done" });
    });

    it("sends execute without parameters when none provided", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeOkResponse({ name: "camera.takePicture", state: "done" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      await client.execute("camera.takePicture");

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({ name: "camera.takePicture", parameters: undefined });
    });
  });

  describe("serial queue", () => {
    it("runs 3 concurrent execute calls in order", async () => {
      const order: number[] = [];
      let resolvers: Array<() => void> = [];

      const fetchMock = vi.fn().mockImplementation(() => {
        return new Promise<Response>((resolve) => {
          resolvers.push(() => {
            order.push(resolvers.length);
            resolve(makeOkResponse({ state: "done" }));
          });
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.useRealTimers();

      const client = new OscClient(BASE_URL);

      const p1 = client.execute("cmd1");
      const p2 = client.execute("cmd2");
      const p3 = client.execute("cmd3");

      // Allow the first fetch to be initiated
      await Promise.resolve();
      await Promise.resolve();

      // Resolve fetch calls one at a time and verify serial ordering
      expect(resolvers).toHaveLength(1); // only first has started
      resolvers[0]();
      await p1;
      // Flush microtasks so next enqueue fires fetch
      await new Promise((r) => setTimeout(r, 0));

      expect(resolvers).toHaveLength(2); // second now started
      resolvers[1]();
      await p2;
      await new Promise((r) => setTimeout(r, 0));

      expect(resolvers).toHaveLength(3); // third now started
      resolvers[2]();
      await p3;

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("error isolation", () => {
    it("second command succeeds even when first command rejects", async () => {
      vi.useRealTimers();
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Camera error"));
        }
        return Promise.resolve(makeOkResponse({ state: "done" }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);

      const p1 = client.execute("cmd1");
      const p2 = client.execute("cmd2");

      await expect(p1).rejects.toThrow("Camera error");
      const result = await p2;
      expect(result).toEqual({ state: "done" });
    });
  });

  describe("pollCommandStatus", () => {
    it("sends POST to /osc/commands/status with id", async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeOkResponse({ id: "abc123", state: "done" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.pollCommandStatus("abc123");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/osc/commands/status`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({ id: "abc123" });
      expect(result).toEqual({ id: "abc123", state: "done" });
    });
  });

  describe("executeAndWait", () => {
    it("polls until state is not inProgress (inProgress -> inProgress -> done)", async () => {
      vi.useRealTimers();
      let fetchCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 1) {
          // execute response
          return Promise.resolve(makeOkResponse({ id: "cmd1", state: "inProgress" }));
        } else if (fetchCount === 2) {
          // first poll: still inProgress
          return Promise.resolve(makeOkResponse({ id: "cmd1", state: "inProgress" }));
        } else {
          // second poll: done
          return Promise.resolve(makeOkResponse({ id: "cmd1", state: "done", results: {} }));
        }
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.executeAndWait(
        "camera.startCapture",
        {},
        {
          pollStartMs: 10,
          pollMaxMs: 50,
          timeoutMs: 5000,
        },
      );

      expect(fetchCount).toBe(3);
      expect(result).toEqual({ id: "cmd1", state: "done", results: {} });
    });

    it("throws timeout error when command stays inProgress past timeoutMs", async () => {
      vi.useRealTimers();
      const fetchMock = vi.fn().mockImplementation(() => {
        return Promise.resolve(makeOkResponse({ id: "cmd1", state: "inProgress" }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      await expect(
        client.executeAndWait(
          "camera.startCapture",
          {},
          {
            pollStartMs: 10,
            pollMaxMs: 50,
            timeoutMs: 100,
          },
        ),
      ).rejects.toThrow("Command camera.startCapture timed out after 100ms");
    });
  });

  describe("transient retry", () => {
    it("retries once on ECONNREFUSED and succeeds on second attempt", async () => {
      vi.useRealTimers();
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const err = new Error("connect ECONNREFUSED");
          (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
          return Promise.reject(err);
        }
        return Promise.resolve(makeOkResponse({ model: "X4" }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.getInfo();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ model: "X4" });
    });

    it("does not retry on non-transient errors", async () => {
      vi.useRealTimers();
      const fetchMock = vi.fn().mockRejectedValue(new Error("Auth failed"));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      await expect(client.getInfo()).rejects.toThrow("Auth failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("HTTP error handling", () => {
    it("throws on non-ok HTTP response", async () => {
      vi.useRealTimers();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "service unavailable" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      await expect(client.getInfo()).rejects.toThrow("returned 503");
    });
  });

  describe("queue depth limit", () => {
    it("rejects with busy error when queue depth exceeds 10", async () => {
      vi.useRealTimers();
      // Never resolves — keeps the queue full
      const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);

      const promises: Promise<unknown>[] = [];
      // First call starts immediately (not queued), then we need 10 more to fill the queue
      for (let i = 0; i < 11; i++) {
        promises.push(client.execute(`cmd${i}`).catch(() => {}));
      }

      // The 12th call should be rejected
      await expect(client.execute("overflow")).rejects.toThrow(
        "Camera busy, too many queued commands",
      );
    });
  });

  describe("init", () => {
    it("calls getInfo then getState and returns both", async () => {
      vi.useRealTimers();
      const infoBody = { model: "X4", firmwareVersion: "1.0" };
      const stateBody = { state: { battery: 75 } };
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(makeOkResponse(infoBody));
        }
        return Promise.resolve(makeOkResponse(stateBody));
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new OscClient(BASE_URL);
      const result = await client.init();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ info: infoBody, state: stateBody });
    });
  });
});
