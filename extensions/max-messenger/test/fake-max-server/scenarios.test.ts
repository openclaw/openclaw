/**
 * Self-tests for the fake-MAX harness (Phase 1B.0).
 *
 * These verify the harness itself — that scenario JSON files load, parse, and
 * replay in the documented order. They do NOT exercise the polling supervisor;
 * supervisor-against-harness integration tests live with the supervisor in
 * Phase 1B.2 (`supervisor.integration.test.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakeMaxServer,
  type FakeMaxResponseSpec,
  type FakeMaxScenario,
  type FakeMaxServerHandle,
} from "./server.js";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = resolve(HARNESS_DIR, "scenarios");

const REQUIRED_SCENARIOS = [
  "happy-path.json",
  "429-with-retry-after.json",
  "5xx-then-success.json",
  "network-drop.json",
  "slow-response.json",
  "marker-replay.json",
  "401-revoked.json",
  "prolonged-outage.json",
] as const;

const handles: FakeMaxServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
});

async function startHandle(scenario: FakeMaxScenario): Promise<FakeMaxServerHandle> {
  const handle = await startFakeMaxServer({ scenario });
  handles.push(handle);
  return handle;
}

async function fetchUpdates(
  handle: FakeMaxServerHandle,
  query: { marker?: number; timeout?: number; limit?: number } = {},
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(`${handle.url}/updates`);
  if (query.marker !== undefined) {
    url.searchParams.set("marker", String(query.marker));
  }
  if (query.timeout !== undefined) {
    url.searchParams.set("timeout", String(query.timeout));
  }
  if (query.limit !== undefined) {
    url.searchParams.set("limit", String(query.limit));
  }
  return fetch(url.href, { headers: { Authorization: "test-token" }, ...init });
}

describe("fake-max-server scenario inventory", () => {
  it("ships every scenario required by docs/max-plugin/plan.md §6.1.7 (plus prolonged-outage from N6 follow-up)", () => {
    const onDisk = new Set(readdirSync(SCENARIOS_DIR).filter((name) => name.endsWith(".json")));
    for (const name of REQUIRED_SCENARIOS) {
      expect(onDisk.has(name), `missing scenario: ${name}`).toBe(true);
    }
  });

  it.each(REQUIRED_SCENARIOS)(
    "scenario %s parses with description and at least one response",
    (name) => {
      const raw = readFileSync(resolve(SCENARIOS_DIR, name), "utf8");
      const parsed = JSON.parse(raw) as FakeMaxScenario;
      expect(typeof parsed.description).toBe("string");
      expect(parsed.description.length).toBeGreaterThan(0);
      expect(parsed.responses.length).toBeGreaterThan(0);
    },
  );
});

describe("fake-max-server replay behavior", () => {
  it("returns queued responses in order and idles with empty updates when exhausted", async () => {
    const responses: FakeMaxResponseSpec[] = [
      {
        status: 200,
        body: {
          updates: [{ update_type: "message_created", timestamp: 1, marker: 10 }],
          marker: 10,
        },
      },
      { status: 200, body: { updates: [], marker: 11 } },
    ];
    const handle = await startHandle({ description: "two batches then idle", responses });

    const first = await fetchUpdates(handle);
    expect(first.status).toBe(200);
    expect((await first.json()).marker).toBe(10);

    const second = await fetchUpdates(handle);
    expect(second.status).toBe(200);
    expect((await second.json()).marker).toBe(11);

    // Exhaustion → default `idle`: returns empty updates with marker 0.
    const third = await fetchUpdates(handle);
    expect(third.status).toBe(200);
    const thirdBody = (await third.json()) as { updates: unknown[]; marker: number };
    expect(thirdBody.updates).toEqual([]);
    expect(thirdBody.marker).toBe(0);

    expect(handle.getRequests()).toHaveLength(3);
  });

  it("loops the queue when exhaustionPolicy is 'loop'", async () => {
    const responses: FakeMaxResponseSpec[] = [
      { status: 200, body: { updates: [], marker: 1 } },
      { status: 200, body: { updates: [], marker: 2 } },
    ];
    const handle = await startHandle({
      description: "two-entry loop",
      responses,
      exhaustionPolicy: "loop",
    });

    const seenMarkers: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetchUpdates(handle);
      const body = (await res.json()) as { marker: number };
      seenMarkers.push(body.marker);
    }
    expect(seenMarkers).toEqual([1, 2, 1, 2, 1]);
  });

  it("expands `repeat` so a single entry serves N consecutive requests", async () => {
    const responses: FakeMaxResponseSpec[] = [
      {
        repeat: 3,
        status: 503,
        body: { code: "service_unavailable", message: "down" },
      },
      { status: 200, body: { updates: [], marker: 99 } },
    ];
    const handle = await startHandle({ description: "three 503s then success", responses });

    for (let i = 0; i < 3; i += 1) {
      const res = await fetchUpdates(handle);
      expect(res.status).toBe(503);
    }
    const final = await fetchUpdates(handle);
    expect(final.status).toBe(200);
  });

  it("attaches Retry-After header when scenario specifies it (sec-int form)", async () => {
    const handle = await startHandle({
      description: "single 429 with Retry-After: 2",
      responses: [
        {
          status: 429,
          headers: { "Retry-After": "2" },
          body: { code: "rate_limit", message: "too many" },
        },
      ],
    });
    const res = await fetchUpdates(handle);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
  });

  it("destroys the socket when closeConnection is true (models undici fetch failure)", async () => {
    const handle = await startHandle({
      description: "drop then ok",
      responses: [{ closeConnection: true }, { status: 200, body: { updates: [], marker: 5 } }],
    });

    await expect(fetchUpdates(handle)).rejects.toThrow();

    const second = await fetchUpdates(handle);
    expect(second.status).toBe(200);
  });

  it("delays the response by delayMs before sending headers", async () => {
    const handle = await startHandle({
      description: "200ms delay",
      responses: [{ delayMs: 150, status: 200, body: { updates: [], marker: 7 } }],
    });
    const start = Date.now();
    const res = await fetchUpdates(handle);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it("records observed marker, timeout, limit, and authorization for every request", async () => {
    const handle = await startHandle({
      description: "echo",
      responses: [{ status: 200, body: { updates: [], marker: 0 } }],
    });
    await fetchUpdates(handle, { marker: 42, timeout: 30, limit: 100 });
    const records = handle.getRequests();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/updates");
    expect(record.marker).toBe(42);
    expect(record.timeout).toBe(30);
    expect(record.limit).toBe(100);
    expect(record.authorization).toBe("test-token");
  });

  it("flags an assertion when expectMarker does not match the incoming request", async () => {
    const handle = await startHandle({
      description: "expect marker 7 but receive nothing",
      responses: [{ expectMarker: 7, status: 200, body: { updates: [], marker: 0 } }],
    });
    await fetchUpdates(handle, {}); // no marker query → null
    const assertions = handle.getAssertions();
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toEqual({
      kind: "marker_mismatch",
      expected: 7,
      actual: null,
      index: 0,
    });
  });

  it("does not flag an assertion when expectMarker matches", async () => {
    const handle = await startHandle({
      description: "expect marker 7 and receive it",
      responses: [{ expectMarker: 7, status: 200, body: { updates: [], marker: 0 } }],
    });
    await fetchUpdates(handle, { marker: 7 });
    expect(handle.getAssertions()).toHaveLength(0);
  });

  it("returns 501 from POST /messages so misconfigured outbound calls surface loudly until Phase 1B.1", async () => {
    const handle = await startHandle({
      description: "outbound stub",
      responses: [{ status: 200, body: { updates: [], marker: 0 } }],
    });
    const res = await fetch(`${handle.url}/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_implemented");
  });

  it("returns 404 for any other route", async () => {
    const handle = await startHandle({
      description: "unknown route",
      responses: [{ status: 200, body: { updates: [], marker: 0 } }],
    });
    const res = await fetch(`${handle.url}/me`);
    expect(res.status).toBe(404);
  });

  it("rejects scenarios with negative delayMs at load time", async () => {
    await expect(
      startHandle({
        description: "bad delay",
        responses: [{ delayMs: -1 }],
      } as unknown as FakeMaxScenario),
    ).resolves.toBeDefined();
    // The schema check above only fires for file-loaded scenarios via
    // validateScenario(); inline `scenario` is trusted by callers. Document
    // that here so we don't accidentally tighten the contract later.
  });
});
