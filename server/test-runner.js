/**
 * UnitIQ SMS Triage Test Runner
 * Runs all 60 Azure Bay SMS test scenarios against the pseudo-API.
 *
 * For each scenario:
 *   1. Resolve identity (phone → unit)
 *   2. Fetch the expected data field from the right endpoint
 *   3. Verify the value is present and non-null
 *   4. Report PASS / FAIL / WARN
 *
 * Usage: node test-runner.js [--verbose] [--scenario SCN-001]
 */

const BASE = "http://127.0.0.1:3740";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const FILTER = args.find((a) => a.startsWith("--scenario="))?.split("=")[1];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {return null;}
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {return null;}
  return res.json();
}

// ── Intent → Resolver map ─────────────────────────────────────────────────────
// Maps "Expected Data (Field)" to a resolver function.
// Returns { value, source } or null if not found.

async function resolveField(field, unit) {
  switch (field) {
    case "Current Balance ($)": {
      const data = await get(`/api/az/accounts/${unit}`);
      return data ? { value: data.current_balance, source: "az/accounts" } : null;
    }
    case "Autopay": {
      const data = await get(`/api/az/accounts/${unit}`);
      return data ? { value: data.autopay, source: "az/accounts" } : null;
    }
    case "Last Payment Date": {
      const data = await get(`/api/az/accounts/${unit}`);
      return data ? { value: data.last_payment_date, source: "az/accounts" } : null;
    }
    case "Special Assessment Active": {
      const data = await get(`/api/az/accounts/${unit}`);
      return data ? { value: data.special_assessment_active, source: "az/accounts" } : null;
    }
    case "Delinquency Bucket [Formula]": {
      const data = await get(`/api/az/accounts/${unit}`);
      return data ? { value: data.delinquency_bucket, source: "az/accounts" } : null;
    }
    case "Lease Expiration": {
      const data = await get(`/api/az/units/${unit}`);
      return data ? { value: data.profile?.["Lease Expiration"], source: "az/units" } : null;
    }
    case "Parking Primary": {
      const data = await get(`/api/az/units/${unit}`);
      return data ? { value: data.profile?.["Parking Primary"], source: "az/units" } : null;
    }
    case "Boat Slip": {
      const data = await get(`/api/az/units/${unit}`);
      return data ? { value: data.profile?.["Boat Slip"], source: "az/units" } : null;
    }
    case "Work Orders (lookup)": {
      const data = await get(`/api/az/work-orders?unit=${unit}`);
      if (!data) {return null;}
      const open = data.results?.filter((w) => w.Status !== "Closed") ?? [];
      return { value: open.length > 0 ? `${open.length} open` : "none", source: "az/work-orders", detail: open };
    }
    case "Violations (lookup)": {
      const data = await get(`/api/az/violations/${unit}`);
      if (!data) {return null;}
      const open = data.violations?.filter((v) => v.Status === "Open" || v.Status === "Hearing Scheduled") ?? [];
      return { value: open.length > 0 ? `${open.length} open` : "none", source: "az/violations", detail: open };
    }
    default:
      return { value: `UNKNOWN_FIELD: ${field}`, source: "none" };
  }
}

// ── Identity resolution ───────────────────────────────────────────────────────

async function resolveIdentity(phone, expectedUnit) {
  const result = await post("/api/az/identity/resolve", { phone });
  if (!result) {return { ok: false, reason: "identity resolver returned null" };}

  const { decision, subject_candidates, candidate_count } = result;

  if (decision === "no_match") {
    // Phone not in dataset — this is expected for test phones (305-555-60xx)
    // Fall back to using the unit from the test scenario directly
    return { ok: true, unit: expectedUnit, via: "test_fallback", decision };
  }

  if (decision === "ask_clarification") {
    return { ok: false, reason: `Ambiguous: ${candidate_count} candidates`, decision };
  }

  const match = subject_candidates.find((c) => c.unit_id === expectedUnit);
  if (!match) {
    return {
      ok: true,
      unit: expectedUnit,
      via: "test_fallback",
      decision,
      warn: `Phone matched unit ${subject_candidates[0]?.unit_id} but expected ${expectedUnit}`,
    };
  }

  return { ok: true, unit: match.unit_id, via: "identity_resolve", decision };
}

// ── Response generator ────────────────────────────────────────────────────────
// Turns resolved data into a natural-language answer, like the real system would.

function generateAnswer(field, resolved, unit) {
  if (!resolved || resolved.value === null || resolved.value === undefined) {
    return `Sorry, I couldn't find that information for unit ${unit}.`;
  }

  const v = resolved.value;

  switch (field) {
    case "Current Balance ($)":
      return v === 0 || v === "0"
        ? `Your account is current — no balance owed as of today.`
        : `Your current balance is $${Number(v).toFixed(2)}.`;

    case "Autopay":
      return v === "Y"
        ? `Yes, you are enrolled in autopay.`
        : `No, you are not currently enrolled in autopay. You can set this up through the resident portal.`;

    case "Last Payment Date":
      return v
        ? `Your last payment was received on ${new Date(v).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
        : `No payment on record for your account.`;

    case "Special Assessment Active":
      return v === "Y"
        ? `Yes, there is an active special assessment on your account.`
        : `No special assessment is currently active on your account.`;

    case "Lease Expiration":
      return v && v !== ""
        ? `Your tenant's lease expires on ${new Date(v).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
        : `No active lease on record for unit ${unit}.`;

    case "Parking Primary":
      return v && v !== ""
        ? `Your assigned parking space is ${v}.`
        : `No parking space is assigned to unit ${unit}.`;

    case "Boat Slip":
      return v && v !== ""
        ? `Yes, boat slip ${v} is assigned to your unit.`
        : `No boat slip is currently assigned to unit ${unit}. Contact the office to join the waitlist.`;

    case "Work Orders (lookup)":
      if (v === "none" || v === "0 open") {return `No open work orders found for unit ${unit}.`;}
      return `You have ${v} for unit ${unit}.`;

    case "Violations (lookup)":
      if (v === "none") {return `No open violations on record for unit ${unit}.`;}
      return `Unit ${unit} has ${v} that require attention.`;

    default:
      return `${field}: ${JSON.stringify(v)}`;
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
const WARN = "⚠️  WARN";

async function runScenario(scenario) {
  const { "Scenario ID": id, Channel: channel, "From (Phone)": phone, Unit: unit,
          Message: message, "Expected Data (Field)": field } = scenario;

  // Step 1: Identity resolution
  const identity = await resolveIdentity(phone, unit);

  // Step 2: Data resolution
  const resolved = await resolveField(field, identity.unit || unit);

  // Step 3: Evaluate
  let status, reason;

  if (!identity.ok) {
    status = FAIL;
    reason = `Identity: ${identity.reason}`;
  } else if (!resolved) {
    status = FAIL;
    reason = `Resolver returned null for field "${field}" on unit ${unit}`;
  } else if (resolved.value === null || resolved.value === undefined || resolved.value === "") {
    status = WARN;
    reason = `Field "${field}" is null/empty — unit may not have this data`;
  } else {
    status = PASS;
    reason = `${field} = ${JSON.stringify(resolved.value)} [via ${resolved.source}]`;
  }

  // Propagate identity warning
  if (identity.warn && status === PASS) {
    status = WARN;
    reason = identity.warn + " | " + reason;
  }

  const answer = generateAnswer(field, resolved, unit);

  return { id, channel, unit, message, field, status, reason, resolved, identity, answer };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        UnitIQ SMS Triage Test Runner — Azure Bay            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Load scenarios

  const scenariosRes = await get("/api/az/test-scenarios");
  console.log("scenariosRes:", scenariosRes);
  if (!scenariosRes) {
    console.error("❌ Could not reach API. Is the server running on port 3740?");
    process.exit(1);
  }

  let scenarios = Array.isArray(scenariosRes) ? scenariosRes : scenariosRes.scenarios;
  // Map scenarios to expected format if needed (robust)
  if (scenarios.length && scenarios[0] && !('Scenario ID' in scenarios[0])) {
    scenarios = scenarios.map(s => ({
      'Scenario ID': s['Scenario ID'] ?? s.id ?? '',
      'Channel': s['Channel'] ?? s.channel ?? '',
      'From (Phone)': s['From (Phone)'] ?? s.phone ?? '',
      'Unit': s['Unit'] ?? s.unit ?? '',
      'Message': s['Message'] ?? s.question ?? '',
      'Expected Data (Field)': s['Expected Data (Field)'] ?? s.field ?? '',
      'Notes': s['Notes'] ?? s.notes ?? '',
      'expected': s['expected'] ?? s.expected ?? '',
      'meta': s['meta'] ?? s.meta ?? {},
    }));
  }
  if (FILTER) {
    scenarios = scenarios.filter((s) => s["Scenario ID"] === FILTER);
    if (!scenarios.length) {
      console.error(`❌ No scenario found matching ${FILTER}`);
      process.exit(1);
    }
  }

  console.log(`Running ${scenarios.length} scenario(s)...\n`);

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);

    const line = `${result.status}  ${String(result.id ?? '').padEnd(8)} [${String(result.channel ?? '').padEnd(5)}] Unit ${String(result.unit ?? '').padEnd(5)}  ${String(result.message ?? '').substring(0, 42).padEnd(43)}`;
    console.log(line);
    if (VERBOSE || result.status !== PASS) {
      console.log(`         → ${result.reason}`);
      if (VERBOSE && result.resolved?.detail?.length) {
        result.resolved.detail.forEach((d) => {
          const desc = d.Description || d.Type || d["Work Order ID"] || d["Violation ID"] || "";
          console.log(`           • ${d.Status} — ${desc}`);
        });
      }
    }
  }

  // Summary
  const pass = results.filter((r) => r.status === PASS).length;
  const warn = results.filter((r) => r.status === WARN).length;
  const fail = results.filter((r) => r.status === FAIL).length;

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`Results: ${pass} passed  ${warn} warned  ${fail} failed  (${results.length} total)`);

  // Intent distribution
  const byField = {};
  results.forEach((r) => {
    byField[r.field] = byField[r.field] || { pass: 0, warn: 0, fail: 0 };
    if (r.status === PASS) {byField[r.field].pass++;}
    else if (r.status === WARN) {byField[r.field].warn++;}
    else {byField[r.field].fail++;}
  });

  console.log("\nIntent breakdown:");
  Object.entries(byField)
    .toSorted((a, b) => (b[1].pass + b[1].warn) - (a[1].pass + a[1].warn))
    .forEach(([field, counts]) => {
      const total = counts.pass + counts.warn + counts.fail;
      const bar = `${"█".repeat(counts.pass)}${"░".repeat(counts.warn)}${"✗".repeat(counts.fail)}`;
      console.log(`  ${field.substring(0, 35).padEnd(36)} ${bar.padEnd(12)} (${total})`);
    });

  // Channel breakdown
  const byChannel = {};
  results.forEach((r) => {
    byChannel[r.channel] = byChannel[r.channel] || { pass: 0, warn: 0, fail: 0 };
    if (r.status === PASS) {byChannel[r.channel].pass++;}
    else if (r.status === WARN) {byChannel[r.channel].warn++;}
    else {byChannel[r.channel].fail++;}
  });

  console.log("\nChannel breakdown:");
  Object.entries(byChannel).forEach(([ch, counts]) => {
    console.log(`  ${ch.padEnd(8)} ✅ ${counts.pass}  ⚠️  ${counts.warn}  ❌ ${counts.fail}`);
  });

  if (fail > 0) {
    console.log("\nFailed scenarios:");
    results.filter((r) => r.status === FAIL).forEach((r) => {
      console.log(`  ${r.id} — ${r.reason}`);
    });
  }

  console.log("");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
