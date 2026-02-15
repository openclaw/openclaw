import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const defaultConnectionString = "postgres://dispatch:dispatch@postgres:5432/dispatch";
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dispatch/db/migrations/001_init.sql",
);

const defaultApiBaseUrl = "http://127.0.0.1:8080";
const connectionString = process.env.DISPATCH_DATABASE_URL || defaultConnectionString;
const demoAccountId =
  process.env.DISPATCH_DEMO_ACCOUNT_ID || "d3f77db0-5d1a-4f9c-b0ea-111111111111";
const demoSiteId = process.env.DISPATCH_DEMO_SITE_ID || "7f6a2b2c-8f1e-4f2b-b3a1-222222222222";
const dispatchApiUrl = process.env.DISPATCH_API_URL || defaultApiBaseUrl;

const parsePositiveInt = (rawValue, fallback) => {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

const runApiReadinessCheck = process.env.DISPATCH_BOOTSTRAP_SKIP_API_READY_CHECK !== "true";
const healthRetries = parsePositiveInt(process.env.DISPATCH_BOOTSTRAP_API_HEALTH_RETRIES, 20);
const healthDelayMs = parsePositiveInt(process.env.DISPATCH_BOOTSTRAP_API_HEALTH_DELAY_MS, 500);
const evidencePath = process.env.DISPATCH_BOOTSTRAP_EVIDENCE_PATH;

const migrationSql = await fs.readFile(migrationPath, "utf8");

const pool = new Pool({
  connectionString,
  max: 1,
});

const log = (...args) => console.log("[dispatch-bootstrap]", ...args);

const normalizeApiBaseUrl = (value) => {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return defaultApiBaseUrl;
  }
  return trimmed;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureContact = async (client) => {
  const existing = await client.query(
    "SELECT id FROM contacts WHERE site_id = $1 AND email = $2 LIMIT 1",
    [demoSiteId, "dispatcher-demo@example.com"],
  );

  if (existing.rows.length > 0) {
    return;
  }

  await client.query(
    `
    INSERT INTO contacts (
      site_id,
      account_id,
      name,
      phone,
      email,
      role,
      is_authorized_requester,
      is_authorized_approver
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,
    [
      demoSiteId,
      demoAccountId,
      "Dispatcher Front Desk",
      "+1-555-0100",
      "dispatcher-demo@example.com",
      "customer",
      true,
      true,
    ],
  );
};

const readFixtureState = async (client) => {
  const state = await client.query(
    `
      SELECT
        (SELECT count(*)::int FROM accounts) AS account_count,
        (SELECT count(*)::int FROM sites) AS site_count,
        (SELECT count(*)::int FROM contacts) AS contact_count,
        (SELECT count(*)::int FROM tickets) AS ticket_count,
        (SELECT count(*)::int FROM audit_events) AS audit_event_count
    `,
  );

  const account = await client.query(
    `
      SELECT id, name, created_at
      FROM accounts
      WHERE id = $1
      LIMIT 1
    `,
    [demoAccountId],
  );

  const site = await client.query(
    `
      SELECT id, account_id, name, city, region
      FROM sites
      WHERE id = $1
      LIMIT 1
    `,
    [demoSiteId],
  );

  const contact = await client.query(
    `
      SELECT id, phone, email
      FROM contacts
      WHERE site_id = $1 AND email = $2
      LIMIT 1
    `,
    [demoSiteId, "dispatcher-demo@example.com"],
  );

  return {
    counts: {
      accounts: state.rows[0].account_count,
      sites: state.rows[0].site_count,
      contacts: state.rows[0].contact_count,
      tickets: state.rows[0].ticket_count,
      audit_events: state.rows[0].audit_event_count,
    },
    demo_account: account.rows[0] ?? null,
    demo_site: site.rows[0] ?? null,
    demo_contact: contact.rows[0] ?? null,
  };
};

const verifyDispatchApiReady = async () => {
  const apiBase = normalizeApiBaseUrl(dispatchApiUrl);
  const url = `${apiBase}/health`;

  if (!runApiReadinessCheck) {
    log("Skipping API readiness check.");
    return {
      endpoint: `${url}`,
      performed: false,
      status: "skipped",
      attempts: 0,
    };
  }

  log(`Checking dispatch API readiness on ${url}`);
  let lastStatus = null;
  let lastBody = null;
  for (let attempt = 1; attempt <= healthRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      lastStatus = response.status;
      const bodyText = await response.text();
      try {
        lastBody = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        lastBody = bodyText;
      }

      if (
        response.ok &&
        lastBody &&
        typeof lastBody === "object" &&
        lastBody.status === "ok" &&
        lastBody.service === "dispatch-api"
      ) {
        log(`Dispatch API ready on attempt ${attempt}/${healthRetries}.`);
        return {
          endpoint: url,
          performed: true,
          status: "ok",
          attempts: attempt,
          body: lastBody,
        };
      }

      log(`Readiness probe attempt ${attempt}/${healthRetries} returned ${response.status}.`);
    } catch (error) {
      lastStatus = error.code ?? "network_error";
      log(
        `Readiness probe attempt ${attempt}/${healthRetries} failed with`,
        error?.message || error,
      );
    }

    if (attempt < healthRetries) {
      await sleep(healthDelayMs);
    }
  }

  throw new Error(`Dispatch API not ready at ${url} after ${healthRetries} attempts`);
};

try {
  const client = await pool.connect();

  try {
    log("Applying migration from", migrationPath);
    await client.query("BEGIN");
    await client.query(migrationSql);
    log("Seeding deterministic demo account + site fixtures");

    await client.query(
      `
      INSERT INTO accounts (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name
    `,
      [demoAccountId, "Demo Home Services"],
    );

    await client.query(
      `
      INSERT INTO sites (
        id,
        account_id,
        name,
        address1,
        city,
        region,
        postal_code,
        access_instructions
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE
        SET
          account_id = EXCLUDED.account_id,
          name = EXCLUDED.name,
          address1 = EXCLUDED.address1,
          city = EXCLUDED.city,
          region = EXCLUDED.region,
          postal_code = EXCLUDED.postal_code,
          access_instructions = EXCLUDED.access_instructions
    `,
      [
        demoSiteId,
        demoAccountId,
        "Demo Site North",
        "100 Demo Drive",
        "Oakland",
        "CA",
        "94607",
        "Enter via code lock on service entrance.",
      ],
    );

    await ensureContact(client);

    await client.query("COMMIT");

    const readiness = await verifyDispatchApiReady();
    const snapshot = await readFixtureState(client);

    const evidence = {
      timestamp: new Date().toISOString(),
      migration: {
        path: migrationPath,
      },
      fixtures: {
        account_id: demoAccountId,
        site_id: demoSiteId,
        account: snapshot.demo_account,
        site: snapshot.demo_site,
        contact: snapshot.demo_contact,
      },
      counts: snapshot.counts,
      ready_check: readiness,
    };

    log("Dispatch stack seed complete.");
    log("account_id:", demoAccountId);
    log("site_id:", demoSiteId);
    log("accounts:", snapshot.counts.accounts);
    log("sites:", snapshot.counts.sites);
    log("contacts:", snapshot.counts.contacts);
    log("tickets:", snapshot.counts.tickets);
    log("Use these fixture IDs for planning and E2E tool payloads.");

    if (evidencePath) {
      const resolvedEvidencePath = path.resolve(evidencePath);
      await fs.writeFile(resolvedEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      log("Wrote bootstrap evidence to", resolvedEvidencePath);
    }

    log("Dispatch bootstrap evidence payload:");
    log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error("[dispatch-bootstrap] failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
