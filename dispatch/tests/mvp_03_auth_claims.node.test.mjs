import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { closePool } from "../api/src/db.mjs";
import { startDispatchApi } from "../api/src/server.mjs";

const repoRoot = process.cwd();
const migrationSql = fs.readFileSync(
  path.resolve(repoRoot, "dispatch/db/migrations/001_init.sql"),
  "utf8",
);

const postgresContainer = "rd-mvp03-test";
const postgresPort = 55444;
const dispatchApiPort = 18094;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000091";
const siteId = "00000000-0000-0000-0000-000000000092";
const outOfScopeAccountId = "00000000-0000-0000-0000-000000000093";
const outOfScopeSiteId = "00000000-0000-0000-0000-000000000094";

const jwtSecret = "dispatch-mvp03-test-secret";
const jwtIssuer = "dispatch-tests";
const jwtAudience = "dispatch-api";

const previousEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DISPATCH_AUTH_ALLOW_DEV_HEADERS: process.env.DISPATCH_AUTH_ALLOW_DEV_HEADERS,
  DISPATCH_AUTH_JWT_SECRET: process.env.DISPATCH_AUTH_JWT_SECRET,
  DISPATCH_AUTH_JWT_ISSUER: process.env.DISPATCH_AUTH_JWT_ISSUER,
  DISPATCH_AUTH_JWT_AUDIENCE: process.env.DISPATCH_AUTH_JWT_AUDIENCE,
  DISPATCH_DATABASE_URL: process.env.DISPATCH_DATABASE_URL,
};

let app;

function run(command, args, input = undefined) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function psql(sql) {
  return run("docker", [
    "exec",
    "-i",
    postgresContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "dispatch",
    "-d",
    "dispatch",
    "-At",
    "-c",
    sql,
  ]);
}

function signClaimsToken(claims, secret = jwtSecret) {
  const encodedHeader = Buffer.from(
    JSON.stringify({
      alg: "HS256",
      typ: "JWT",
    }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function buildClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "dispatcher-mvp03",
    role: "dispatcher",
    actor_type: "HUMAN",
    account_ids: [accountId],
    site_ids: [siteId],
    iss: jwtIssuer,
    aud: jwtAudience,
    exp: now + 3600,
    ...overrides,
  };
}

async function post(pathname, headers, payload = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    body: bodyText ? JSON.parse(bodyText) : null,
  };
}

async function get(pathname, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "GET",
    headers,
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    body: bodyText ? JSON.parse(bodyText) : null,
  };
}

function authHeaders({
  token,
  requestId = null,
  toolName,
  correlationId,
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Tool-Name": toolName,
    "X-Correlation-Id": correlationId,
  };
  if (requestId) {
    headers["Idempotency-Key"] = requestId;
  }
  return headers;
}

test.before(async () => {
  spawnSync("docker", ["rm", "-f", postgresContainer], { encoding: "utf8" });
  run("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    postgresContainer,
    "-e",
    "POSTGRES_USER=dispatch",
    "-e",
    "POSTGRES_PASSWORD=dispatch",
    "-e",
    "POSTGRES_DB=dispatch",
    "-p",
    `${postgresPort}:5432`,
    "postgres:16",
  ]);

  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    const probe = spawnSync(
      "docker",
      ["exec", postgresContainer, "pg_isready", "-U", "dispatch", "-d", "dispatch"],
      { encoding: "utf8" },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await sleep(500);
  }

  if (!ready) {
    throw new Error("Postgres container did not become ready");
  }

  run(
    "docker",
    [
      "exec",
      "-i",
      postgresContainer,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "dispatch",
      "-d",
      "dispatch",
    ],
    migrationSql,
  );

  psql(`
    INSERT INTO accounts (id, name)
    VALUES
      ('${accountId}', 'MVP 03 Account'),
      ('${outOfScopeAccountId}', 'MVP 03 Other Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES
      ('${siteId}', '${accountId}', 'MVP 03 Site', '91 Main St', 'Springfield'),
      ('${outOfScopeSiteId}', '${outOfScopeAccountId}', 'MVP 03 Other Site', '94 Main St', 'Springfield');
  `);

  process.env.NODE_ENV = "production";
  process.env.DISPATCH_AUTH_ALLOW_DEV_HEADERS = "false";
  process.env.DISPATCH_AUTH_JWT_SECRET = jwtSecret;
  process.env.DISPATCH_AUTH_JWT_ISSUER = jwtIssuer;
  process.env.DISPATCH_AUTH_JWT_AUDIENCE = jwtAudience;
  process.env.DISPATCH_DATABASE_URL = `postgres://dispatch:dispatch@127.0.0.1:${postgresPort}/dispatch`;

  app = await startDispatchApi({
    host: "127.0.0.1",
    port: dispatchApiPort,
  });
});

test.after(async () => {
  if (app) {
    await app.stop();
  }
  await closePool();
  spawnSync("docker", ["rm", "-f", postgresContainer], { encoding: "utf8" });

  for (const [key, value] of Object.entries(previousEnv)) {
    if (typeof value === "string") {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
});

test("production mode rejects header-only actor context", async () => {
  const response = await post(
    "/tickets",
    {
      "Idempotency-Key": "b3000000-0000-4000-8000-000000000001",
      "X-Actor-Id": "dispatcher-header-only",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": "corr-mvp03-header-only",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "MVP-03 header-only auth should fail",
    },
  );

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTH_REQUIRED");
  const ticketCount = Number(
    psql(
      "SELECT count(*) FROM tickets WHERE summary = 'MVP-03 header-only auth should fail';",
    ),
  );
  assert.equal(ticketCount, 0);
});

test("valid signed claims allow in-scope create and read", async () => {
  const dispatcherToken = signClaimsToken(buildClaims({
    sub: "dispatcher-claims-valid",
  }));

  const create = await post(
    "/tickets",
    authHeaders({
      token: dispatcherToken,
      requestId: "b3000000-0000-4000-8000-000000000002",
      toolName: "ticket.create",
      correlationId: "corr-mvp03-valid",
    }),
    {
      account_id: accountId,
      site_id: siteId,
      summary: "MVP-03 valid claims path",
    },
  );

  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const ticketRead = await get(
    `/tickets/${ticketId}`,
    authHeaders({
      token: dispatcherToken,
      toolName: "ticket.get",
      correlationId: "corr-mvp03-read",
    }),
  );

  assert.equal(ticketRead.status, 200);
  assert.equal(ticketRead.body.id, ticketId);
  assert.equal(ticketRead.body.account_id, accountId);
  assert.equal(ticketRead.body.site_id, siteId);
});

test("invalid or forged signed claims fail closed", async () => {
  const forgedToken = signClaimsToken(
    buildClaims({
      sub: "dispatcher-forged",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
    "wrong-secret",
  );

  const forgedResponse = await post(
    "/tickets",
    authHeaders({
      token: forgedToken,
      requestId: "b3000000-0000-4000-8000-000000000003",
      toolName: "ticket.create",
      correlationId: "corr-mvp03-forged",
    }),
    {
      account_id: accountId,
      site_id: siteId,
      summary: "MVP-03 forged token should fail",
    },
  );
  assert.equal(forgedResponse.status, 401);
  assert.equal(forgedResponse.body.error.code, "INVALID_AUTH_TOKEN");

  const expiredToken = signClaimsToken(
    buildClaims({
      sub: "dispatcher-expired",
      exp: Math.floor(Date.now() / 1000) - 60,
    }),
  );

  const expiredResponse = await post(
    "/tickets",
    authHeaders({
      token: expiredToken,
      requestId: "b3000000-0000-4000-8000-000000000004",
      toolName: "ticket.create",
      correlationId: "corr-mvp03-expired",
    }),
    {
      account_id: accountId,
      site_id: siteId,
      summary: "MVP-03 expired token should fail",
    },
  );

  assert.equal(expiredResponse.status, 401);
  assert.equal(expiredResponse.body.error.code, "INVALID_AUTH_CLAIMS");
});

test("claims role and account/site scope are enforced on ticket operations", async () => {
  const inScopeDispatcher = signClaimsToken(buildClaims({
    sub: "dispatcher-scope-owner",
  }));
  const create = await post(
    "/tickets",
    authHeaders({
      token: inScopeDispatcher,
      requestId: "b3000000-0000-4000-8000-000000000005",
      toolName: "ticket.create",
      correlationId: "corr-mvp03-scope-create",
    }),
    {
      account_id: accountId,
      site_id: siteId,
      summary: "MVP-03 scope guard ticket",
    },
  );
  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const outOfScopeDispatcher = signClaimsToken(buildClaims({
    sub: "dispatcher-out-of-scope",
    account_ids: [outOfScopeAccountId],
    site_ids: [outOfScopeSiteId],
  }));

  const scopeBlockedMutation = await post(
    `/tickets/${ticketId}/triage`,
    authHeaders({
      token: outOfScopeDispatcher,
      requestId: "b3000000-0000-4000-8000-000000000006",
      toolName: "ticket.triage",
      correlationId: "corr-mvp03-scope-mutation",
    }),
    {
      priority: "URGENT",
      incident_type: "MVP03_SCOPE_CHECK",
    },
  );
  assert.equal(scopeBlockedMutation.status, 403);
  assert.equal(scopeBlockedMutation.body.error.code, "FORBIDDEN_SCOPE");
  assert.equal(psql(`SELECT state FROM tickets WHERE id = '${ticketId}';`), "NEW");

  const scopeBlockedRead = await get(
    `/tickets/${ticketId}`,
    authHeaders({
      token: outOfScopeDispatcher,
      toolName: "ticket.get",
      correlationId: "corr-mvp03-scope-read",
    }),
  );
  assert.equal(scopeBlockedRead.status, 403);
  assert.equal(scopeBlockedRead.body.error.code, "FORBIDDEN_SCOPE");

  const customerToken = signClaimsToken(buildClaims({
    sub: "customer-role-token",
    role: "customer",
  }));
  const roleBlockedMutation = await post(
    `/tickets/${ticketId}/triage`,
    authHeaders({
      token: customerToken,
      requestId: "b3000000-0000-4000-8000-000000000007",
      toolName: "ticket.triage",
      correlationId: "corr-mvp03-role-forbidden",
    }),
    {
      priority: "URGENT",
      incident_type: "MVP03_ROLE_CHECK",
    },
  );
  assert.equal(roleBlockedMutation.status, 403);
  assert.equal(roleBlockedMutation.body.error.code, "FORBIDDEN");
});
