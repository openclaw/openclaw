import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureSource } from "./scan-bundled.mjs";

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

async function bundledFixture(t, unnamed = false) {
  const root = await mkdtemp(path.join(tmpdir(), "sdk-impact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugins = [];
  for (const [pluginId, packageName] of [
    ["local", "@openclaw/local"],
    ["published", "example"],
  ]) {
    const relativeRoot = `extensions/${pluginId}`;
    await mkdir(path.join(root, relativeRoot), { recursive: true });
    await writeFile(
      path.join(root, relativeRoot, "openclaw.plugin.json"),
      JSON.stringify({ id: pluginId }),
    );
    if (!unnamed || pluginId !== "local") {
      await writeFile(
        path.join(root, relativeRoot, "package.json"),
        JSON.stringify({ name: packageName, openclaw: { extensions: ["./index.ts"] } }),
      );
    }
    plugins.push({
      pluginId,
      packageName: unnamed && pluginId === "local" ? null : packageName,
      relativeRoot,
      sdkUsage: {
        schemaVersion: 1,
        analysisVersion: "1",
        inputKind: "source",
        status: "complete",
        coverage: { filesDiscovered: 1, filesAnalyzed: 1, filesExcluded: 0 },
        entries: [
          {
            key,
            kind: "api-member",
            identity: "api.registerTool",
            classification: "runtime",
            referenceKinds: ["call"],
            evidence: consumer.evidence,
            deprecationCodes: [],
          },
        ],
        unknowns: [],
      },
    });
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  ]);
  const { source, plugins: metadata } = await captureSource(root);
  for (const [index, item] of plugins.entries()) {
    Object.assign(item, metadata[index]);
  }
  const report = {
    schemaVersion: 1,
    traversalComplete: true,
    generatedAt: "2026-10-17T00:00:00Z",
    inspectorVersion: "0.4.3",
    source,
    plugins,
  };
  const file = path.join(root, "inventory.json");
  const save = () => writeFile(file, JSON.stringify(report));
  await save();
  return { root, file, report, save };
}
function coverage(status = "complete", unknownCount = 0) {
  return { scope: "page", items: [{ ...plugin, status, unknownCount }], nextCursor: null };
}

async function query(t, respond, args, now) {
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
    [...clock, script, key, "--base-url", baseUrl, ...(args ?? [])],
    {
      timeout: 5000,
    },
  ).then(
    (value) => ({ ...value, code: 0 }),
    (error) => error,
  );
  assert.ok(result.stdout, result.stderr);
  return { code: result.code, report: JSON.parse(result.stdout), stdout: result.stdout };
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

test("CLI keeps large paginated inventories readable without losing aggregate coverage", async (t) => {
  const since = "2026-07-16T12:00:00.000Z";
  const releasedSince = 1784203200000;
  const consumers = Array.from({ length: 12 }, (_, index) => ({
    ...consumer,
    packageName: `consumer-${String(index).padStart(2, "0")}`,
    releaseId: `consumer-release-${index}`,
    releaseCreatedAt: releasedSince,
  }));
  const roster = [
    ...consumers.map(({ packageName, releaseId, version, releaseCreatedAt }) => ({
      packageName,
      releaseId,
      version,
      releaseCreatedAt,
      status: "complete",
      unknownCount: 0,
    })),
    ...Array.from({ length: 1143 }, (_, index) => ({
      packageName: `missing-${index}`,
      releaseId: `missing-release-${index}`,
      version: "1.0.0",
      releaseCreatedAt: releasedSince,
      status: "missing",
      unknownCount: 0,
    })),
    {
      packageName: "partial-last",
      releaseId: "partial-release",
      version: "1.0.0",
      releaseCreatedAt: releasedSince,
      status: "partial",
      unknownCount: 7,
    },
  ];
  const respond = (url) => {
    assert.equal(url.searchParams.get("releasedSince"), String(releasedSince));
    const records = url.pathname.endsWith("/coverage") ? roster : consumers;
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const end = offset + 100;
    return {
      key,
      scope: "page",
      releasedSince,
      items: records.slice(offset, end),
      nextCursor: end < records.length ? String(end) : null,
    };
  };
  const { code, report, stdout } = await query(t, respond, ["--since", since]);
  assert.equal(code, 0);
  assert.ok(
    Buffer.byteLength(stdout) < 16_000,
    "chat output must retain its count and coverage header",
  );
  assert.equal(report.key, key);
  assert.equal(report.releaseWindow.latestReleaseUploadedSince, since);
  assert.equal(report.traversalComplete, true);
  assert.equal(report.assessment, "incomplete-coverage");
  assert.equal(report.distinctPlugins, 12);
  assert.deepEqual(report.referenceCounts, { runtime: 12, type: 12, declarative: 0 });
  assert.deepEqual(report.coverage, {
    eligible: 1156,
    complete: 12,
    partial: 1,
    failed: 0,
    missing: 1143,
    incompatible: 0,
    unresolvedReferences: 7,
  });
  assert.equal(report.items.length, 5);
  assert.deepEqual(report.items[0].evidence, consumer.evidence);
  assert.equal(report.gaps.length, 5);
  assert.deepEqual(report.output, {
    detail: "summary",
    exampleLimit: 5,
    omitted: { items: 7, gaps: 1139, warnings: 0 },
  });
  assert.ok(report.source.startsWith("http://127.0.0.1:"));

  const full = await query(t, respond, ["--since", since, "--full"]);
  assert.equal(full.code, 0);
  assert.equal(full.report.distinctPlugins, 12);
  assert.equal(full.report.coverage.eligible, 1156);
  assert.equal(full.report.coverage.unresolvedReferences, 7);
  assert.equal(full.report.items.length, 12);
  assert.equal(full.report.gaps.length, 1144);
  assert.equal(full.report.gaps.at(-1).packageName, "partial-last");
  assert.deepEqual(full.report.output, {
    detail: "full",
    exampleLimit: null,
    omitted: { items: 0, gaps: 0, warnings: 0 },
  });
});

test("bundled consumers are included once across sources and remain visible with a release window", async (t) => {
  const fixture = await bundledFixture(t);
  const { code, report } = await query(
    t,
    (url) => {
      const releasedSince = Number(url.searchParams.get("releasedSince"));
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
    ["--bundled", fixture.file, "--months", "3"],
  );
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.distinctPlugins, 1);
  assert.equal(report.bundled.distinctPlugins, 2);
  assert.equal(report.bundled.coverage.complete, 2);
  assert.equal(report.bundled.releaseWindow, null);
  assert.equal(report.combined.distinctPlugins, 2);
  assert.equal(report.combined.overlappingConsumers, 1);
  assert.equal(report.combined.eligiblePlugins, 2);
  assert.equal(report.combined.assessment, "observed-consumers");
});

test("bundled gaps cannot turn an empty ClawHub result into a confident zero", async (t) => {
  const fixture = await bundledFixture(t);
  fixture.report.plugins[0].sdkUsage.entries = [];
  fixture.report.plugins[1].sdkUsage.entries = [];
  fixture.report.plugins[1].sdkUsage.status = "partial";
  fixture.report.plugins[1].sdkUsage.unknowns = [
    { path: "index.ts", line: 1, reason: "computed member" },
  ];
  await fixture.save();
  const respond = (url) =>
    url.pathname.endsWith("/coverage") ? coverage() : { key, items: [], nextCursor: null };
  const { report } = await query(t, respond, ["--bundled", fixture.file]);
  assert.ok(report.combined, JSON.stringify(report));
  assert.equal(report.combined.distinctPlugins, 0);
  assert.equal(report.combined.assessment, "incomplete-coverage");
  assert.equal(report.bundled.coverage.partial, 1);
  assert.equal(report.bundled.coverage.unresolvedReferences, 1);
  const missing = await query(t, respond);
  assert.equal(missing.report.combined.distinctPlugins, null);
  assert.equal(missing.report.combined.assessment, "unavailable");
});

test("stale or incomplete bundled inventories fail instead of reusing a zero", async (t) => {
  const fixture = await bundledFixture(t);
  const respond = (url) =>
    url.pathname.endsWith("/coverage") ? coverage() : { key, items: [], nextCursor: null };
  const original = structuredClone(fixture.report);
  for (const mutate of [
    () => {
      fixture.report.plugins.pop();
    },
    () => {
      fixture.report.source.commit = "0".repeat(40);
    },
  ]) {
    Object.assign(fixture.report, structuredClone(original));
    mutate();
    await fixture.save();
    const result = await query(t, respond, ["--bundled", fixture.file]);
    assert.equal(result.code, 1);
    assert.equal(result.report.distinctPlugins, null);
    assert.match(result.report.error, /inventory roster|inventory commit/);
  }
});

test("manifest-only bundled plugins preserve consumers without inventing exact cross-source overlap", async (t) => {
  const fixture = await bundledFixture(t, true);
  // Only the unnamed local plugin uses the method; the public match might be it.
  fixture.report.plugins[1].sdkUsage.entries = [];
  await fixture.save();
  const { code, report } = await query(
    t,
    (url) =>
      url.pathname.endsWith("/coverage")
        ? coverage()
        : { key, items: [consumer], nextCursor: null },
    ["--bundled", fixture.file],
  );
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.bundled.distinctPlugins, 1);
  assert.equal(report.bundled.coverage.complete, 1);
  assert.equal(report.bundled.coverage.partial, 1);
  assert.equal(report.bundled.gaps[0].status, "partial");
  assert.match(report.bundled.gaps[0].error, /implicit host entrypoint/);
  assert.equal(report.combined.distinctPlugins, null);
  assert.deepEqual(report.combined.distinctPluginBounds, { min: 1, max: 2 });
  assert.equal(report.combined.observedPluginIdentities, 2);
});
