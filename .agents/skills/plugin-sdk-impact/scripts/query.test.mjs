import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("query.mjs", import.meta.url));
const key = "api-member:api.registerTool";
const plugin = { packageName: "example", releaseId: "release-1", version: "1.0.0" };
const consumer = {
  ...plugin,
  key,
  classification: "mixed",
  referenceKinds: ["call", "type-reference"],
  evidence: [{ path: "index.js", line: 2, snippet: "api.registerTool(tool)" }],
  scan: {
    status: "complete",
    schemaVersion: 1,
    analysisVersion: "1",
    inputKind: "artifact",
    unknownCount: 0,
  },
};
function coverage(status = "complete", unknownCount = 0) {
  return { scope: "page", items: [{ ...plugin, status, unknownCount }], nextCursor: null };
}

async function query(t, respond, args = [], now = undefined) {
  // The OS reserves a fresh loopback port; no fixed port or external service is used.
  const server = createServer((request, response) => {
    const result = respond(new URL(request.url, "http://localhost"));
    response.writeHead(result.httpStatus ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body ?? result));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const clock = now
    ? [
        "--import",
        `data:text/javascript,${encodeURIComponent(`const OriginalDate = Date; globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [${JSON.stringify(now)}])); } static now() { return new OriginalDate(${JSON.stringify(now)}).getTime(); } };`)}`,
      ]
    : [];
  const result = await exec(
    process.execPath,
    [...clock, script, key, "--base-url", baseUrl, ...args],
    {
      timeout: 5000,
    },
  ).then(
    (value) => ({ ...value, code: 0 }),
    (error) => error,
  );
  assert.ok(result.stdout, result.stderr);
  return { code: result.code, report: JSON.parse(result.stdout) };
}

test("CLI follows empty intermediate pages and reports distinct consumers with evidence", async (t) => {
  const { code, report } = await query(t, (url) => {
    if (url.pathname.endsWith("/coverage")) {
      return url.searchParams.has("cursor")
        ? coverage()
        : { scope: "page", items: [], nextCursor: "coverage-2" };
    }
    assert.equal(url.searchParams.get("key"), key);
    return url.searchParams.has("cursor")
      ? { key, items: [consumer], nextCursor: null }
      : { key, items: [], nextCursor: "usage-2" };
  });
  assert.equal(code, 0);
  assert.equal(report.assessment, "observed-consumers");
  assert.equal(report.distinctPlugins, 1);
  assert.equal(report.coverage.complete, 1);
  assert.equal(report.traversalComplete, true);
  assert.deepEqual(report.items[0].evidence, consumer.evidence);
  assert.deepEqual(report.referenceCounts, { runtime: 1, type: 1, declarative: 0 });
});

test("CLI uses the same release cutoff for consumers and coverage on every page", async (t) => {
  const since = "2026-07-16T12:00:00.000Z";
  const releasedSince = 1784203200000;
  const { code, report } = await query(
    t,
    (url) => {
      assert.equal(url.searchParams.get("releasedSince"), String(releasedSince));
      if (!url.searchParams.has("cursor")) {
        return { key, scope: "page", releasedSince, items: [], nextCursor: "more" };
      }
      return url.pathname.endsWith("/coverage")
        ? {
            ...coverage(),
            releasedSince,
            items: [
              { ...plugin, releaseCreatedAt: releasedSince, status: "complete", unknownCount: 0 },
            ],
          }
        : {
            key,
            releasedSince,
            items: [{ ...consumer, releaseCreatedAt: releasedSince }],
            nextCursor: null,
          };
    },
    ["--since", since],
  );
  assert.equal(code, 0);
  assert.equal(report.distinctPlugins, 1);
  assert.equal(report.coverage.eligible, 1);
  assert.deepEqual(report.releaseWindow, {
    latestReleaseUploadedSince: since,
    timezone: "UTC",
    inclusive: true,
  });
});

test("completed empty results remain distinct from incomplete coverage and an empty corpus", async (t) => {
  for (const [status, unknownCount, expected] of [
    ["complete", 0, "no-observed-consumers"],
    ["partial", 0, "incomplete-coverage"],
    ["failed", 0, "incomplete-coverage"],
    ["missing", 0, "incomplete-coverage"],
    ["incompatible", 0, "incomplete-coverage"],
    ["complete", 1, "incomplete-coverage"],
    [null, 0, "empty-corpus"],
  ]) {
    const { code, report } = await query(t, (url) =>
      url.pathname.endsWith("/coverage")
        ? status
          ? coverage(status, unknownCount)
          : { scope: "page", items: [], nextCursor: null }
        : { key, items: [], nextCursor: null },
    );
    assert.equal(code, 0);
    assert.equal(report.assessment, expected);
    assert.equal(report.distinctPlugins, 0);
  }
});

test("failed or malformed traversal produces unknown counts, never a successful zero", async (t) => {
  for (const response of [
    { httpStatus: 503, body: { message: "unavailable" } },
    { key, items: [] },
    { key, items: [], nextCursor: "repeated" },
    {
      key,
      items: [{ ...consumer, scan: { ...consumer.scan, inputKind: "source" } }],
      nextCursor: null,
    },
  ]) {
    const { code, report } = await query(t, () => response);
    assert.equal(code, 1);
    assert.equal(report.assessment, "unavailable");
    assert.equal(report.distinctPlugins, null);
    assert.equal(report.traversalComplete, false);
  }
});

test("a page budget and a changing release prevent claims of complete traversal", async (t) => {
  const bounded = await query(t, () => ({ key, items: [], nextCursor: "more" }), [
    "--max-pages",
    "1",
  ]);
  assert.equal(bounded.code, 1);
  assert.equal(bounded.report.distinctPlugins, null);

  const changed = await query(t, (url) =>
    url.pathname.endsWith("/coverage")
      ? {
          ...coverage(),
          items: [{ ...plugin, releaseId: "release-2", status: "complete", unknownCount: 0 }],
        }
      : { key, items: [consumer], nextCursor: null },
  );
  assert.equal(changed.code, 0);
  assert.equal(changed.report.assessment, "incomplete-coverage");
  assert.match(changed.report.warnings.join(" "), /changed/);
});

test("three calendar months clamps month ends in UTC, including leap years", async (t) => {
  for (const [now, since] of [
    ["2026-05-31T23:30:00.000Z", "2026-02-28T23:30:00.000Z"],
    ["2024-05-31T23:30:00.000Z", "2024-02-29T23:30:00.000Z"],
    ["2026-01-31T23:30:00.000Z", "2025-10-31T23:30:00.000Z"],
  ]) {
    const { code, report } = await query(
      t,
      (url) => {
        assert.equal(url.searchParams.get("releasedSince"), String(Date.parse(since)));
        return {
          key,
          scope: "page",
          releasedSince: Date.parse(since),
          items: [],
          nextCursor: null,
        };
      },
      ["--months", "3"],
      now,
    );
    assert.equal(code, 0);
    assert.equal(report.releaseWindow.latestReleaseUploadedSince, since);
    assert.equal(report.observedAt, now);
  }
});

test("a server ignoring the filter or returning out-of-window releases leaves counts unknown", async (t) => {
  const releasedSince = 1784203200000;
  for (const page of [
    { key, items: [], nextCursor: null },
    { key, releasedSince, items: [consumer], nextCursor: null },
    {
      key,
      releasedSince,
      items: [{ ...consumer, releaseCreatedAt: releasedSince - 1 }],
      nextCursor: null,
    },
  ]) {
    const { code, report } = await query(t, () => page, ["--since", "2026-07-16T12:00:00Z"]);
    assert.equal(code, 1);
    assert.equal(report.distinctPlugins, null);
  }
});

test("invalid or conflicting date filters fail before making a request", async (t) => {
  for (const args of [
    ["--since", "2026-02-30T00:00:00Z"],
    ["--since", "2026-07-16"],
    ["--months", "0"],
    ["--months", "1.5"],
    ["--months", "999999999"],
    ["--months", "3", "--since", "2026-07-16T12:00:00Z"],
  ]) {
    const { code, report } = await query(
      t,
      () => assert.fail("invalid filter sent HTTP request"),
      args,
    );
    assert.equal(code, 1);
    assert.equal(report.distinctPlugins, null);
  }
});
