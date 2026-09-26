import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { acquireQaLease, resumeQaLease, QaCredentialBrokerError } from "./qa-credential-lease.mjs";

const env = {
  OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test/",
  OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
};

function acquiredResponse(payload = { schemaVersion: 1 }) {
  return Response.json({
    status: "ok",
    credentialId: "synthetic-credential",
    leaseToken: "synthetic-token",
    payload,
  });
}

test("a resumed event loop cannot use a lease whose confirmation expired", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  context.mock.method(performance, "now", () => Date.now());
  const operations = [];
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    leaseTtlMs: 100,
    heartbeatIntervalMs: 10,
    env,
    fetchImpl: async (url) => {
      operations.push(url.split("/").at(-1));
      return Response.json(
        url.endsWith("/acquire")
          ? { status: "ok", credentialId: "synthetic", leaseToken: "synthetic", payload: {} }
          : { status: "ok" },
      );
    },
  });
  assert.doesNotThrow(() => lease.assertHealthy());
  // Advance both clocks without delivering the suspended heartbeat callbacks.
  context.mock.timers.setTime(150);
  assert.throws(() => lease.assertHealthy(), /confirmation expired/u);
  await lease.abandon();
  assert.deepEqual(operations, ["acquire", "heartbeat"]);
});

test("release immediately revokes retained access even while the broker reply is pending", async () => {
  let finishRelease;
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    env,
    fetchImpl: async (url) => {
      if (url.endsWith("/acquire")) {
        return acquiredResponse({});
      }
      if (url.endsWith("/release")) {
        return new Promise((resolve) => {
          finishRelease = () => resolve(Response.json({ status: "ok" }));
        });
      }
      return Response.json({ status: "ok" });
    },
  });
  const pending = lease.release();
  assert.throws(() => lease.assertHealthy(), /released/u);
  assert.match((await lease.whenUnhealthy).message, /released/u);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  finishRelease();
  await pending;
});

test("rejects a partial explicit broker configuration instead of mixing sources", async () => {
  let cliCalls = 0;
  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      env: { OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test" },
      runConvexCliImpl: async () => {
        cliCalls += 1;
      },
    }),
    /Set both OPENCLAW_QA_CONVEX_SITE_URL and OPENCLAW_QA_CONVEX_SECRET_CI/u,
  );
  assert.equal(cliCalls, 0);
});

test("rejects remote cleartext broker URLs before fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      env: { ...env, OPENCLAW_QA_CONVEX_SITE_URL: "http://broker.example.test" },
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ status: "ok" });
      },
    }),
    /must use https/u,
  );
  assert.equal(fetchCalls, 0);
});

test("allows explicit IPv4 and IPv6 loopback HTTP for local broker development", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/acquire")) {
      return acquiredResponse();
    }
    return Response.json({ status: "ok" });
  };
  for (const siteUrl of ["http://127.0.0.1:3210/", "http://[::1]:3210/"]) {
    const lease = await acquireQaLease({
      kind: "telegram-test-userbot",
      env: {
        ...env,
        OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
        OPENCLAW_QA_CONVEX_SITE_URL: siteUrl,
      },
      fetchImpl,
    });
    await lease.release();
  }
});

test("acquires, heartbeats, and releases one credential", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, authorization: init.headers.authorization });
    if (url.endsWith("/acquire")) {
      return acquiredResponse();
    }
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    ownerId: "test-owner",
    heartbeatIntervalMs: 10,
    env,
    fetchImpl,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
  lease.assertHealthy();
  await lease.release();
  await lease.release();

  assert.deepEqual(lease.payload, { schemaVersion: 1 });
  assert.equal(calls[0].body.kind, "telegram-test-userbot");
  assert.equal(calls[0].authorization, "Bearer ci-secret");
  assert.ok(calls.some((call) => call.url.endsWith("/heartbeat")));
  assert.equal(calls.filter((call) => call.url.endsWith("/release")).length, 1);
});

test("accepts empty successful heartbeat and release replies", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return acquiredResponse();
    }
    return new Response(null, { status: 204 });
  };
  const lease = await acquireQaLease({ kind: "telegram-test-userbot", env, fetchImpl });
  await lease.release();
  assert.equal(calls.filter((url) => url.endsWith("/heartbeat")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("waits for a pooled credential and preserves the broker retry delay", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (!url.endsWith("/acquire")) {
      return Response.json({ status: "ok" });
    }
    attempts += 1;
    if (attempts === 1) {
      return Response.json(
        {
          status: "error",
          code: "POOL_EXHAUSTED",
          message: "No credential is available.",
          retryAfterMs: 2000,
        },
        { status: 409 },
      );
    }
    return acquiredResponse();
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    env,
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  await lease.release();
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("retries the exact Convex credential-row contention error with jitter", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (!url.endsWith("/acquire")) {
      return Response.json({ status: "ok" });
    }
    attempts += 1;
    if (attempts === 1) {
      return Response.json(
        {
          status: "error",
          code: "INTERNAL_ERROR",
          message:
            'Documents read from or written to the "credential_sets" table changed while this mutation was being run and on every subsequent retry.',
        },
        { status: 500 },
      );
    }
    return acquiredResponse();
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    env,
    fetchImpl,
    randomImpl: () => 0.5,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  await lease.release();
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [175]);
});

test("does not retry unrelated broker internal errors", async () => {
  let attempts = 0;
  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      env,
      fetchImpl: async () => {
        attempts += 1;
        return Response.json(
          { status: "error", code: "INTERNAL_ERROR", message: "Unexpected broker failure." },
          { status: 500 },
        );
      },
    }),
    (error) => error instanceof QaCredentialBrokerError && error.code === "INTERNAL_ERROR",
  );
  assert.equal(attempts, 1);
});

test("stops reading an oversized streamed broker response at the byte limit", async () => {
  let pulls = 0;
  let cancelled = false;
  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      env,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(700_000));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    }),
    /response exceeded 1048576 bytes/u,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test("hydrates an authenticated broker payload above the inline threshold", async () => {
  const expected = { schemaVersion: 1, archive: "x".repeat(300_000) };
  const serialized = JSON.stringify(expected);
  const chunks = [
    serialized.slice(0, 120_000),
    serialized.slice(120_000, 240_000),
    serialized.slice(240_000),
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, authorization: init.headers.authorization });
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-chunked",
        leaseToken: "lease-token-chunked",
        payload: {
          __openclawQaCredentialPayloadChunksV1: true,
          chunkCount: chunks.length,
          byteLength: Buffer.byteLength(serialized, "utf8"),
        },
      });
    }
    if (url.endsWith("/payload-chunk")) {
      return Response.json({ status: "ok", data: chunks[body.index] });
    }
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({ kind: "telegram-test-userbot", env, fetchImpl });
  assert.deepEqual(lease.payload, expected);
  const chunkCalls = calls.filter((call) => call.url.endsWith("/payload-chunk"));
  assert.deepEqual(
    chunkCalls.map((call) => call.body.index),
    [0, 1, 2],
  );
  assert.ok(chunkCalls.every((call) => call.authorization === "Bearer ci-secret"));
  await lease.release();
});

test("rejects an inline credential when its initial heartbeat fails", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return acquiredResponse();
    }
    if (url.endsWith("/heartbeat")) {
      return Response.json(
        { status: "error", code: "LEASE_EXPIRED", message: "Lease expired." },
        { status: 409 },
      );
    }
    return Response.json({ status: "ok" });
  };

  await assert.rejects(
    acquireQaLease({ kind: "telegram-test-userbot", env, fetchImpl }),
    (error) => error instanceof QaCredentialBrokerError && error.code === "LEASE_EXPIRED",
  );
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("heartbeat loss stops delayed chunk hydration before returning credentials", async () => {
  let heartbeatCount = 0;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-delayed-chunk",
        leaseToken: "lease-token-delayed-chunk",
        payload: {
          __openclawQaCredentialPayloadChunksV1: true,
          chunkCount: 2,
          byteLength: 4,
        },
      });
    }
    if (url.endsWith("/heartbeat")) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        return Response.json({ status: "ok" });
      }
      return Response.json(
        { status: "error", code: "LEASE_EXPIRED", message: "Lease expired." },
        { status: 409 },
      );
    }
    if (url.endsWith("/payload-chunk")) {
      return await new Promise(() => {});
    }
    return Response.json({ status: "ok" });
  };

  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      heartbeatIntervalMs: 5,
      env,
      fetchImpl,
    }),
    (error) => error instanceof QaCredentialBrokerError && error.code === "LEASE_EXPIRED",
  );
  assert.equal(calls.filter((url) => url.endsWith("/payload-chunk")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("reports pool exhaustion after the acquire budget", async () => {
  const fetchImpl = async () =>
    Response.json(
      {
        status: "error",
        code: "POOL_EXHAUSTED",
        message: "No credential is available.",
        retryAfterMs: 2000,
      },
      { status: 409 },
    );
  await assert.rejects(
    acquireQaLease({ kind: "telegram-test-userbot", acquireTimeoutMs: 0, env, fetchImpl }),
    (error) =>
      error instanceof QaCredentialBrokerError &&
      error.code === "POOL_EXHAUSTED" &&
      error.retryAfterMs === 2000,
  );
});

test("surfaces terminal heartbeat loss and still releases", async () => {
  const calls = [];
  let heartbeatCount = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return acquiredResponse();
    }
    if (url.endsWith("/heartbeat")) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        return Response.json({ status: "ok" });
      }
      return Response.json(
        { status: "error", code: "LEASE_EXPIRED", message: "Lease expired." },
        { status: 409 },
      );
    }
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    heartbeatIntervalMs: 5,
    env,
    fetchImpl,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  assert.throws(
    () => lease.assertHealthy(),
    (error) => error instanceof QaCredentialBrokerError && error.code === "LEASE_EXPIRED",
  );
  await lease.release();
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("fences a stalled heartbeat and bounds lease cleanup", async () => {
  let released = false;
  let heartbeatCount = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/acquire")) {
      return acquiredResponse();
    }
    if (url.endsWith("/heartbeat")) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        return Response.json({ status: "ok" });
      }
      return await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    released = true;
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    heartbeatIntervalMs: 5,
    httpTimeoutMs: 10,
    env,
    fetchImpl,
  });
  const heartbeatError = await Promise.race([
    lease.whenUnhealthy,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("heartbeat did not fence")), 100);
    }),
  ]);
  assert.throws(
    () => lease.assertHealthy(),
    (error) => error === heartbeatError,
  );
  await lease.release();
  assert.equal(released, true);
});

test("concurrent and later release calls share the same failed owner result", async () => {
  const response = Promise.withResolvers();
  const started = Promise.withResolvers();
  let releases = 0;
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    env,
    fetchImpl: async (url) => {
      if (url.endsWith("/acquire")) {
        return acquiredResponse({});
      }
      if (url.endsWith("/release")) {
        releases += 1;
        started.resolve();
        await response.promise;
        return Response.json(
          { status: "error", code: "RELEASE_FAILED", message: "temporarily unavailable" },
          { status: 503 },
        );
      }
      return Response.json({ status: "ok" });
    },
  });
  const first = lease.release();
  const second = lease.release();
  await started.promise;
  response.resolve();
  const failure = await first.catch((error) => error);
  assert.equal(releases, 1);
  await assert.rejects(second, (error) => error === failure);
  await assert.rejects(lease.release(), (error) => error === failure);
  assert.equal(releases, 1);
});

test("retained lease recovery revalidates the same owner without acquiring a replacement", async () => {
  const recovery = {
    identity: {
      kind: "telegram-test-userbot",
      credentialId: "held-credential",
      ownerId: "held-owner",
      actorRole: "ci",
      leaseToken: "held-token",
    },
    leaseTtlMs: 1_200_000,
    heartbeatIntervalMs: 30_000,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push(method);
    assert.equal(body.credentialId, recovery.identity.credentialId);
    assert.equal(body.ownerId, recovery.identity.ownerId);
    assert.equal(body.leaseToken, recovery.identity.leaseToken);
    return Response.json({ status: "ok" });
  };
  const lease = await resumeQaLease({ recovery, env, fetchImpl });
  lease.assertHealthy();
  await lease.release();
  assert.deepEqual(calls, ["heartbeat", "release"]);
  await assert.rejects(
    resumeQaLease({
      recovery,
      env,
      fetchImpl: async (url) => {
        assert.ok(url.endsWith("/heartbeat"));
        return Response.json(
          { status: "error", code: "LEASE_EXPIRED", message: "owner expired" },
          { status: 409 },
        );
      },
    }),
    /LEASE_EXPIRED/,
  );
});

test("cancellation retains an in-flight acquire until its exact lease is released", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const calls = [];
  const acquire = acquireQaLease({
    kind: "telegram-test-userbot",
    env,
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      calls.push(url.split("/").at(-1));
      if (url.endsWith("/acquire")) {
        started.resolve(init.signal);
        return await reply.promise;
      }
      return Response.json({ status: "ok" });
    },
  });
  const requestSignal = await started.promise;
  const reason = new Error("acquisition cancelled");
  controller.abort(reason);
  assert.equal(
    requestSignal.aborted,
    false,
    "do not discard an acquire that may have succeeded remotely",
  );
  reply.resolve(acquiredResponse({}));
  await assert.rejects(acquire, (error) => error === reason);
  assert.equal(calls.filter((method) => method === "acquire").length, 1);
  assert.equal(calls.filter((method) => method === "release").length, 1);
});

async function launcherFixture(context, scripts) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-convex-launchers-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, "calls.jsonl");
  for (const [name, script] of Object.entries(scripts)) {
    fs.writeFileSync(
      path.join(root, name),
      `#!${process.execPath}\n` +
        `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)}, args})+'\\n');\n` +
        script,
      { mode: 0o755 },
    );
  }
  return {
    env: { PATH: root },
    convexProjectDir: root,
    calls: () =>
      fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

const authenticatedLauncher = `
const request = args.slice(args.indexOf('env'));
if (JSON.stringify(request) !== JSON.stringify(['env', '--deployment', 'reminiscent-ibex-847', 'get', 'OPENCLAW_QA_CONVEX_SECRET_CI'])) {
  console.error('No CONVEX_DEPLOYMENT set; local project selection is unavailable');
  process.exitCode = 1;
} else console.log('synthetic-ci-secret');
`;

for (const winner of ["bunx", "npx"]) {
  test(`discovers authenticated ${winner} without installing or local deployment configuration`, async (context) => {
    const scripts = {
      convex:
        "console.error('Not authenticated: synthetic-private-diagnostic'); process.exitCode = 1;",
      [winner]: authenticatedLauncher,
    };
    const fixture = await launcherFixture(context, scripts);
    const requests = [];
    const lease = await acquireQaLease({
      kind: "telegram-test-userbot",
      ...fixture,
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: init.headers.authorization });
        return Response.json(
          url.endsWith("/acquire")
            ? { status: "ok", credentialId: "owned", leaseToken: "token", payload: {} }
            : { status: "ok" },
        );
      },
    });
    await lease.release();
    assert.ok(
      requests.every(
        ({ url, authorization }) =>
          url.startsWith("https://reminiscent-ibex-847.convex.site/") &&
          authorization === "Bearer synthetic-ci-secret",
      ),
    );
    const selected = fixture.calls().filter(({ name }) => name === winner);
    assert.equal(selected.length, 1);
    for (const { args } of selected) {
      assert.deepEqual(
        args.slice(0, winner === "bunx" ? 2 : 4),
        winner === "bunx"
          ? ["--no-install", "convex"]
          : ["--offline", "--no", "--ignore-scripts", "convex"],
      );
    }
  });
}

for (const [bunxCode, bunxDiagnostic] of [
  ["AUTH_REQUIRED", "Not authenticated"],
  [
    "UNAVAILABLE",
    "error: Could not find an existing 'convex' binary to run. Stopping because --no-install was passed.",
  ],
]) {
  test(`exhausts launchers with bunx ${bunxCode} and redacts their output`, async (context) => {
    const denied =
      "console.error('Not authenticated: synthetic-private-token'); process.exitCode = 1;";
    const fixture = await launcherFixture(context, {
      convex: denied,
      bunx: `console.error(${JSON.stringify(`${bunxDiagnostic}: synthetic-private-token`)}); process.exitCode = 1;`,
      npx: denied,
    });
    await assert.rejects(
      acquireQaLease({
        kind: "telegram-test-userbot",
        ...fixture,
        fetchImpl: async () => assert.fail("unauthenticated discovery cannot acquire a lease"),
      }),
      (error) => {
        assert.match(error.message, new RegExp(`bunx convex: ${bunxCode}`));
        assert.match(error.message, /No existing launcher can authenticate/);
        assert.doesNotMatch(String(error.stack), /synthetic-private-token/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(
      fixture.calls().map(({ name }) => name),
      ["convex", "bunx", "npx"],
    );
  });
}

test("an authenticated CLI's empty env output requests broker configuration, not another login", async (context) => {
  const fixture = await launcherFixture(context, {
    convex: "console.error('Environment variable not found');",
  });
  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      ...fixture,
      fetchImpl: async () => assert.fail("missing broker secret cannot acquire a lease"),
    }),
    (error) => {
      assert.match(error.message, /BROKER_CONFIG/);
      assert.match(error.message, /An existing launcher authenticated/);
      assert.doesNotMatch(error.message, /Ask the user to provide authenticated/);
      return true;
    },
  );
});

test("project-access errors do not misdiagnose missing authentication", async (context) => {
  const fixture = await launcherFixture(context, {
    convex: "console.error('Forbidden: no access to deployment'); process.exitCode = 1;",
  });
  await assert.rejects(acquireQaLease({ kind: "telegram-test-userbot", ...fixture }), (error) => {
    assert.match(error.message, /access to the broker project/);
    assert.doesNotMatch(error.message, /Ask the user to provide authenticated/);
    return true;
  });
});

test("cancellation joins the active Convex launcher and never tries another", async (context) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const fixture = await launcherFixture(context, {
    // A create event can arrive before writeFileSync publishes the PID bytes.
    convex: `
const pidPath = require('node:path').join(__dirname, 'pid');
fs.writeFileSync(pidPath + '.tmp', String(process.pid));
fs.renameSync(pidPath + '.tmp', pidPath);
setInterval(() => {}, 1000);
`,
    bunx: authenticatedLauncher,
  });
  const pidPath = path.join(fixture.convexProjectDir, "pid");
  const started = Promise.withResolvers();
  const watcher = fs.watch(fixture.convexProjectDir, () => {
    if (fs.existsSync(pidPath)) {
      started.resolve();
    }
  });
  const controller = new AbortController();
  const reason = new Error("cancelled credential lookup");
  const pending = acquireQaLease({
    kind: "telegram-test-userbot",
    ...fixture,
    signal: controller.signal,
    fetchImpl: async () => assert.fail("cancelled discovery cannot acquire a lease"),
  }).catch((error) => error);
  let timer;
  try {
    await Promise.race([
      started.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("launcher did not start")), 5_000);
      }),
    ]);
    controller.abort(reason);
    assert.equal(await pending, reason);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidPath, "utf8")), 0), {
      code: "ESRCH",
    });
    assert.deepEqual(
      fixture.calls().map(({ name }) => name),
      ["convex"],
    );
  } finally {
    clearTimeout(timer);
    controller.abort(reason);
    await pending;
    watcher.close();
  }
});

test("normal scoped release revokes the lease without turning successful work into cancellation", async () => {
  const { withTelegramRun } = await import("./telegram-run-scope.mjs");
  let lease;
  const operations = [];
  const result = await withTelegramRun(async (scope) => {
    lease = await acquireQaLease({
      kind: "telegram-test-userbot",
      env,
      fetchImpl: async (url) => {
        operations.push(url.split("/").at(-1));
        return Response.json(
          url.endsWith("/acquire")
            ? { status: "ok", credentialId: "owned", leaseToken: "token", payload: {} }
            : { status: "ok" },
        );
      },
    });
    scope.observeLease({
      assertLeaseHealthy: lease.assertHealthy,
      whenLeaseUnhealthy: lease.whenUnhealthy,
      release: lease.release,
    });
    return "recorded";
  });
  assert.equal(result, "recorded");
  assert.deepEqual(operations, ["acquire", "heartbeat", "release"]);
  assert.throws(() => lease.assertHealthy(), /released/);
});
