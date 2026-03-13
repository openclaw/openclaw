/**
 * AppFolio Pseudo-API Server
 * Mimics AppFolio API endpoints using exported report data.
 * Used for UnitIQ / AskTenant feature testing without a live API key.
 *
 * Base URL: http://localhost:3740/api
 *
 * v2: Added Azure Bay Residences demo property (850 units) + updated AppFolio reports
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3740;
const DATA_DIR = path.join(__dirname, "../data");

// ── Data loader ──────────────────────────────────────────────────────────────

function load(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const db = {
  // AppFolio (real properties — Fort Lauderdale portfolio)
  homeowners: load("homeowners"),
  delinquency: load("delinquency"), // updated 2026-03-10
  violations: load("violations"),
  dues: load("dues"),
  dues_roll: load("dues_roll"), // new: includes past_due, nsf_count, late_count
  renters: load("renters"), // updated 2026-03-10
  work_orders: load("work_orders_v2"), // updated 2026-03-10
  vehicles: load("vehicles"), // updated 2026-03-10
  mailed_letters: load("mailed_letters"), // updated 2026-03-10

  // Azure Bay Residences — 850-unit demo property
  az_units: load("az_units"),
  az_accounts: load("az_accounts"),
  az_parking: load("az_parking"),
  az_boatslips: load("az_boatslips"),
  az_vendors: load("az_vendors"),
  az_work_orders: load("az_work_orders"),
  az_violations: load("az_violations"),
  az_notices: load("az_notices"),
  az_sms_tests: load("az_sms_tests"),
};

console.log("Loaded records:");
Object.entries(db).forEach(([k, v]) => console.log(`  ${k}: ${v.length}`));

// ── Helpers ───────────────────────────────────────────────────────────────────

const norm = (s) => (s || "").toString().trim().toUpperCase();

function byUnit(dataset, field = "Unit") {
  return (unit) => dataset.filter((r) => norm(r[field]) === norm(unit));
}

function paginate(arr, req) {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  return {
    total: arr.length,
    limit,
    offset,
    results: arr.slice(offset, offset + limit),
  };
}

function phoneMatch(phone, query) {
  if (!phone || !query) {
    return false;
  }
  const clean = (s) => s.replace(/\D/g, "");
  return clean(phone).includes(clean(query)) || clean(query).includes(clean(phone));
}

function emailMatch(email, query) {
  if (!email || !query) {
    return false;
  }
  return norm(email) === norm(query);
}

// ── Request logging ───────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path}${
      Object.keys(req.query).length ? " ? " + JSON.stringify(req.query) : ""
    }`,
  );
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    service: "AppFolio Pseudo-API",
    version: "2.0.0",
    properties: {
      appfolio_portfolio: "Fort Lauderdale HOA portfolio (real data, 2026-03-10)",
      azure_bay: "Azure Bay Residences — 850-unit demo property",
    },
    endpoints: {
      appfolio: [
        "GET  /api/homeowners",
        "GET  /api/homeowners/:unit",
        "GET  /api/delinquency",
        "GET  /api/delinquency/:unit",
        "GET  /api/dues/:unit",
        "GET  /api/dues-roll/:unit",
        "GET  /api/violations",
        "GET  /api/violations/:unit",
        "GET  /api/renters",
        "GET  /api/renters/:unit",
        "GET  /api/work-orders",
        "GET  /api/work-orders/:number",
        "GET  /api/vehicles/:unit",
        "GET  /api/letters",
        "GET  /api/units/:unit",
        "POST /api/identity/resolve",
        "GET  /api/pm/delinquency-summary",
        "GET  /api/pm/violations-summary",
        "GET  /api/pm/work-orders-summary",
      ],
      azure_bay: [
        "GET  /api/az/units",
        "GET  /api/az/units/:unit",
        "GET  /api/az/accounts",
        "GET  /api/az/accounts/:unit",
        "GET  /api/az/violations",
        "GET  /api/az/violations/:unit",
        "GET  /api/az/work-orders",
        "GET  /api/az/work-orders/:id",
        "GET  /api/az/parking/:unit",
        "GET  /api/az/boat-slips/:unit",
        "GET  /api/az/vendors",
        "GET  /api/az/notices",
        "POST /api/az/identity/resolve",
        "GET  /api/az/pm/summary",
        "GET  /api/az/test-scenarios",
      ],
    },
  });
});

// ── Homeowners ────────────────────────────────────────────────────────────────

// GET /api/homeowners?status=Current&property=...&renter_occupied=No
app.get("/api/homeowners", (req, res) => {
  let results = db.homeowners;
  if (req.query.status) {
    results = results.filter((r) => norm(r.Status) === norm(req.query.status));
  }
  if (req.query.renter_occupied) {
    results = results.filter(
      (r) => norm(r["Renter Occupied Unit"]) === norm(req.query.renter_occupied),
    );
  }
  if (req.query.property) {
    results = results.filter((r) => norm(r.Property).includes(norm(req.query.property)));
  }
  if (req.query.q) {
    const q = norm(req.query.q);
    results = results.filter(
      (r) =>
        norm(r.Homeowner).includes(q) ||
        norm(r.Unit).includes(q) ||
        norm(r.Emails).includes(q) ||
        norm(r["Phone Numbers"]).includes(q),
    );
  }
  res.json(paginate(results, req));
});

// GET /api/homeowners/:unit
app.get("/api/homeowners/:unit", (req, res) => {
  const records = byUnit(db.homeowners)(req.params.unit);
  if (!records.length) {
    return res.status(404).json({ error: "Unit not found" });
  }
  res.json(records.length === 1 ? records[0] : records);
});

// ── Delinquency ───────────────────────────────────────────────────────────────

// GET /api/delinquency?min_balance=500&aging=30+
app.get("/api/delinquency", (req, res) => {
  let results = db.delinquency;
  if (req.query.min_balance) {
    results = results.filter(
      (r) => (r["Amount Receivable"] || 0) >= parseFloat(req.query.min_balance),
    );
  }
  if (req.query.aging === "30+") {
    results = results.filter((r) => (r["30+"] || 0) > 0);
  }
  if (req.query.aging === "0-30") {
    results = results.filter((r) => (r["0-30"] || 0) > 0 && !(r["30+"] || 0));
  }
  res.json(paginate(results, req));
});

// GET /api/delinquency/:unit
app.get("/api/delinquency/:unit", (req, res) => {
  const records = byUnit(db.delinquency)(req.params.unit);
  if (!records.length) {
    return res.json({ unit: req.params.unit, delinquent: false });
  }
  const r = records[0];
  res.json({
    unit: r.Unit,
    name: r.Name,
    delinquent: (r["Amount Receivable"] || 0) > 0,
    amount_receivable: r["Amount Receivable"],
    aging_0_30: r["0-30"],
    aging_30_plus: r["30+"],
    last_payment: r["Last Payment"],
    last_payment_amount: r["Payment Amount"],
    late_count: r["Late Count"],
  });
});

// ── Violations ────────────────────────────────────────────────────────────────

// GET /api/violations?status=In+Progress
app.get("/api/violations", (req, res) => {
  let results = db.violations;
  if (req.query.status) {
    results = results.filter((r) => norm(r.Status) === norm(req.query.status));
  }
  if (req.query.homeowner) {
    results = results.filter((r) => norm(r.Homeowner).includes(norm(req.query.homeowner)));
  }
  res.json(paginate(results, req));
});

// GET /api/violations/:unit  (matches on unit address fragment or unit ID)
app.get("/api/violations/:unit", (req, res) => {
  const q = norm(req.params.unit);
  const records = db.violations.filter(
    (r) => norm(r["Unit Address"]).includes(q) || norm(r.Homeowner).includes(q),
  );
  if (!records.length) {
    return res.json({ unit: req.params.unit, violations: [] });
  }
  res.json({ unit: req.params.unit, violations: records });
});

// ── Dues ──────────────────────────────────────────────────────────────────────

// GET /api/dues/:unit
app.get("/api/dues/:unit", (req, res) => {
  const records = byUnit(db.dues)(req.params.unit);
  if (!records.length) {
    return res.status(404).json({ error: "Unit not found in dues roll" });
  }
  const r = records[0];
  res.json({
    unit: r.Unit,
    total_dues: r.Total,
    maintenance_fees: r["Maintenance Fees"],
    special_assessments: r["Special Assessments"],
    parking: r["Parking Lot"],
    other_charges: r["Other Charges"],
  });
});

// ── Renters ───────────────────────────────────────────────────────────────────

// GET /api/renters
app.get("/api/renters", (req, res) => {
  let results = db.renters;
  if (req.query.property) {
    results = results.filter((r) => norm(r.Property).includes(norm(req.query.property)));
  }
  res.json(paginate(results, req));
});

// GET /api/renters/:unit
app.get("/api/renters/:unit", (req, res) => {
  const records = byUnit(db.renters)(req.params.unit);
  if (!records.length) {
    return res.json({ unit: req.params.unit, renter: null });
  }
  res.json(records[0]);
});

// ── Work Orders ───────────────────────────────────────────────────────────────

// GET /api/work-orders?status=Assigned&priority=Normal
app.get("/api/work-orders", (req, res) => {
  let results = db.work_orders;
  if (req.query.status) {
    results = results.filter((r) => norm(r.Status) === norm(req.query.status));
  }
  if (req.query.priority) {
    results = results.filter((r) => norm(r.Priority) === norm(req.query.priority));
  }
  if (req.query.unit) {
    results = results.filter((r) => norm(r.Unit) === norm(req.query.unit));
  }
  if (req.query.vendor) {
    results = results.filter((r) => norm(r.Vendor).includes(norm(req.query.vendor)));
  }
  res.json(paginate(results, req));
});

// GET /api/work-orders/:number
app.get("/api/work-orders/:number", (req, res) => {
  const wo = db.work_orders.find((r) => norm(r["Work Order Number"]) === norm(req.params.number));
  if (!wo) {
    return res.status(404).json({ error: "Work order not found" });
  }
  res.json(wo);
});

// ── Vehicles ──────────────────────────────────────────────────────────────────

// GET /api/vehicles/:unit
app.get("/api/vehicles/:unit", (req, res) => {
  const records = byUnit(db.vehicles)(req.params.unit);
  if (!records.length) {
    return res.json({ unit: req.params.unit, vehicles: [] });
  }
  res.json({
    unit: req.params.unit,
    vehicles: records.map((r) => ({
      make: r.Make,
      model: r.Model,
      color: r.Color,
      year: r.Year,
      license_plate: r["License Plate"],
      permit_number: r["Permit Number"],
    })),
  });
});

// ── Mailed Letters ────────────────────────────────────────────────────────────

// GET /api/letters?recipient=...&association=...
app.get("/api/letters", (req, res) => {
  let results = db.mailed_letters;
  if (req.query.recipient) {
    results = results.filter((r) => norm(r.Recipients).includes(norm(req.query.recipient)));
  }
  if (req.query.association) {
    results = results.filter((r) => norm(r.Association).includes(norm(req.query.association)));
  }
  res.json(paginate(results, req));
});

// ── Composite Unit Lookup ─────────────────────────────────────────────────────

// GET /api/units/:unit  — full picture for a unit
app.get("/api/units/:unit", (req, res) => {
  const unit = req.params.unit;
  const homeowner = byUnit(db.homeowners)(unit);
  const renter = byUnit(db.renters)(unit);
  const dues = byUnit(db.dues)(unit);
  const delinquency = byUnit(db.delinquency)(unit);
  const vehicles = byUnit(db.vehicles)(unit);

  if (!homeowner.length && !renter.length) {
    return res.status(404).json({ error: "Unit not found" });
  }

  res.json({
    unit,
    homeowners: homeowner,
    renters: renter,
    dues: dues[0] || null,
    delinquency: delinquency[0] || null,
    vehicles,
  });
});

// ── Identity Resolution ───────────────────────────────────────────────────────

/**
 * POST /api/identity/resolve
 * Body: { "phone": "...", "email": "..." }
 *
 * Returns subject_candidates array — the first step in the
 * Identity Resolution State Machine from IDENTITY_RESOLUTION_STATE_MACHINE.md
 *
 * Enforcement invariant: caller must select an active_subject before
 * calling any protected resolver.
 */
app.post("/api/identity/resolve", (req, res) => {
  const { phone, email } = req.body || {};
  if (!phone && !email) {
    return res.status(400).json({ error: "Provide phone or email" });
  }

  const candidates = [];

  // Match homeowners
  db.homeowners.forEach((r) => {
    const phoneHit = phone && phoneMatch(r["Phone Numbers"], phone);
    const emailHit = email && emailMatch(r.Emails, email);
    if (phoneHit || emailHit) {
      candidates.push({
        subject_id: `owner_${norm(r.Unit).replace(/\s/g, "_")}`,
        role: "owner",
        name: r.Homeowner,
        unit_id: r.Unit,
        property: r.Property,
        match_by: phoneHit ? "phone" : "email",
        verification_state: "soft_match",
      });
    }
  });

  // Match renters
  db.renters.forEach((r) => {
    const phoneHit = phone && phoneMatch(r["Phone Numbers"], phone);
    const emailHit = email && emailMatch(r.Emails, email);
    if (phoneHit || emailHit) {
      candidates.push({
        subject_id: `renter_${norm(r.Unit).replace(/\s/g, "_")}`,
        role: "renter",
        name: r.Renter,
        unit_id: r.Unit,
        property: r.Property,
        match_by: phoneHit ? "phone" : "email",
        verification_state: "soft_match",
      });
    }
  });

  const ambiguous = candidates.length > 1;

  res.json({
    channel_identity: {
      type: phone ? "sms" : "email",
      value: phone || email,
    },
    candidate_count: candidates.length,
    subject_candidates: candidates,
    active_subject: null, // caller must select
    decision:
      candidates.length === 0
        ? "no_match"
        : ambiguous
          ? "ask_clarification"
          : "allow_with_verification",
    note: ambiguous
      ? "Multiple subjects found. active_subject must be explicitly selected before protected resolvers execute."
      : candidates.length === 0
        ? "No matching homeowner or renter found for this contact."
        : "Single candidate found. Proceed to verification before protected reads.",
  });
});

// ── PM Analytics ──────────────────────────────────────────────────────────────

// GET /api/pm/delinquency-summary
app.get("/api/pm/delinquency-summary", (req, res) => {
  const records = db.delinquency;
  const total_ar = records.reduce((s, r) => s + (r["Amount Receivable"] || 0), 0);
  const aging_0_30 = records.reduce((s, r) => s + (r["0-30"] || 0), 0);
  const aging_30_plus = records.reduce((s, r) => s + (r["30+"] || 0), 0);

  // Top 10 by balance (exclude subtotal rows that have no unit or name)
  const top10 = [...records]
    .filter((r) => r.Unit && r.Name && norm(r.Unit) !== "TOTAL")
    .toSorted((a, b) => (b["Amount Receivable"] || 0) - (a["Amount Receivable"] || 0))
    .slice(0, 10)
    .map((r) => ({
      unit: r.Unit,
      name: r.Name,
      amount_receivable: r["Amount Receivable"],
      aging_30_plus: r["30+"],
    }));

  res.json({
    as_of: "2026-02-19",
    total_delinquent_units: records.length,
    total_ar: Math.round(total_ar * 100) / 100,
    aging_0_30: Math.round(aging_0_30 * 100) / 100,
    aging_30_plus: Math.round(aging_30_plus * 100) / 100,
    top_10_by_balance: top10,
  });
});

// GET /api/pm/violations-summary
app.get("/api/pm/violations-summary", (req, res) => {
  const records = db.violations;
  const byStatus = {};
  const byRule = {};

  records.forEach((r) => {
    byStatus[r.Status] = (byStatus[r.Status] || 0) + 1;
    const rule = r.Rule || "Unknown";
    byRule[rule] = (byRule[rule] || 0) + 1;
  });

  const topRules = Object.entries(byRule)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([rule, count]) => ({ rule, count }));

  res.json({
    as_of: "2026-02-19",
    total_violations: records.length,
    by_status: byStatus,
    top_rules: topRules,
  });
});

// GET /api/pm/work-orders-summary
app.get("/api/pm/work-orders-summary", (req, res) => {
  const records = db.work_orders;
  const byStatus = {};
  const byPriority = {};

  records.forEach((r) => {
    byStatus[r.Status] = (byStatus[r.Status] || 0) + 1;
    byPriority[r.Priority] = (byPriority[r.Priority] || 0) + 1;
  });

  const open = records.filter((r) => !["Completed", "Cancelled"].includes(r.Status));

  res.json({
    as_of: "2026-02-19",
    total_work_orders: records.length,
    open_work_orders: open.length,
    by_status: byStatus,
    by_priority: byPriority,
  });
});

// ── Dues Roll (extended) ──────────────────────────────────────────────────────

// GET /api/dues-roll/:unit  — includes past_due, nsf_count, late_count
app.get("/api/dues-roll/:unit", (req, res) => {
  const records = byUnit(db.dues_roll)(req.params.unit);
  if (!records.length) {
    return res.status(404).json({ error: "Unit not found in dues roll" });
  }
  const r = records[0];
  res.json({
    unit: r.Unit,
    homeowner: r.Homeowner,
    dues: r.Dues,
    past_due: r["Past Due"],
    nsf_count: r["NSF Count"],
    late_count: r["Late Count"],
    tags: r.Tags,
  });
});

// ── Azure Bay: Units ──────────────────────────────────────────────────────────

// GET /api/az/units?occupancy_type=Owner&floor=3&sms_opt_in=Y
app.get("/api/az/units", (req, res) => {
  let results = db.az_units;
  if (req.query.occupancy_type) {
    results = results.filter((r) => norm(r["Occupancy Type"]) === norm(req.query.occupancy_type));
  }
  if (typeof req.query.floor === "string") {
    results = results.filter((r) => String(r.Floor) === req.query.floor);
  }
  if (req.query.unit_type) {
    results = results.filter((r) => norm(r["Unit Type"]) === norm(req.query.unit_type));
  }
  if (req.query.sms_opt_in) {
    results = results.filter((r) => norm(r["SMS Opt-In"]) === norm(req.query.sms_opt_in));
  }
  if (req.query.q) {
    const q = norm(req.query.q);
    results = results.filter(
      (r) =>
        norm(r["Owner Name"]).includes(q) ||
        norm(r["Tenant Name"]).includes(q) ||
        norm(r["Owner Email"]).includes(q) ||
        norm(r["Owner Phone"]).includes(q) ||
        norm(r.Unit).includes(q),
    );
  }
  res.json(paginate(results, req));
});

// GET /api/az/units/:unit
app.get("/api/az/units/:unit", (req, res) => {
  const unit = byUnit(db.az_units)(req.params.unit);
  const account = byUnit(db.az_accounts)(req.params.unit);
  const parking = db.az_parking.filter((r) => norm(r["Assigned Unit"]) === norm(req.params.unit));
  const boatslip = db.az_boatslips.filter(
    (r) => norm(r["Assigned Unit"]) === norm(req.params.unit),
  );

  if (!unit.length) {
    return res.status(404).json({ error: "Unit not found" });
  }

  res.json({
    unit: req.params.unit,
    profile: unit[0],
    account: account[0] || null,
    parking,
    boat_slips: boatslip,
  });
});

// ── Azure Bay: Accounts / AR ──────────────────────────────────────────────────

// GET /api/az/accounts?delinquency_bucket=30-60&payment_plan=Y
app.get("/api/az/accounts", (req, res) => {
  let results = db.az_accounts;
  if (req.query.delinquency_bucket) {
    results = results.filter(
      (r) => norm(r["Delinquency Bucket [Formula]"]) === norm(req.query.delinquency_bucket),
    );
  }
  if (req.query.payment_plan) {
    results = results.filter((r) => norm(r["Payment Plan"]) === norm(req.query.payment_plan));
  }
  if (req.query.autopay) {
    results = results.filter((r) => norm(r["Autopay"]) === norm(req.query.autopay));
  }
  if (req.query.special_assessment) {
    results = results.filter(
      (r) => norm(r["Special Assessment Active"]) === norm(req.query.special_assessment),
    );
  }
  if (req.query.min_balance) {
    results = results.filter(
      (r) => (r["Current Balance ($)"] || 0) >= parseFloat(req.query.min_balance),
    );
  }
  res.json(paginate(results, req));
});

// GET /api/az/accounts/:unit
app.get("/api/az/accounts/:unit", (req, res) => {
  const records = byUnit(db.az_accounts)(req.params.unit);
  if (!records.length) {
    return res.status(404).json({ error: "Unit not found" });
  }
  const r = records[0];
  res.json({
    unit: r.Unit,
    account_holder: r["Account Holder (Owner)"],
    monthly_assessment: r["Monthly Assessment ($)"],
    annual_assessment: r["Annual Assessment ($) [Formula]"],
    current_balance: r["Current Balance ($)"],
    special_assessment_active: r["Special Assessment Active"],
    special_assessment_balance: r["Special Assessment Balance ($)"],
    last_payment_date: r["Last Payment Date"],
    last_payment_amount: r["Last Payment Amount ($)"],
    payment_method: r["Payment Method"],
    last_due_date: r["Last Assessment Due Date"],
    days_past_due: r["Days Past Due [Formula]"],
    delinquency_bucket: r["Delinquency Bucket [Formula]"],
    late_fees: r["Late Fees ($)"],
    payment_plan: r["Payment Plan"],
    autopay: r["Autopay"],
    delinquent: (r["Current Balance ($)"] || 0) > 0,
  });
});

// ── Azure Bay: Violations ─────────────────────────────────────────────────────

// GET /api/az/violations?status=Open&type=...
app.get("/api/az/violations", (req, res) => {
  let results = db.az_violations;
  if (req.query.status) {
    results = results.filter((r) => norm(r.Status) === norm(req.query.status));
  }
  if (req.query.type) {
    results = results.filter((r) => norm(r.Type).includes(norm(req.query.type)));
  }
  if (req.query.unit) {
    results = results.filter((r) => norm(r.Unit) === norm(req.query.unit));
  }
  if (req.query.hearing_required) {
    results = results.filter(
      (r) => norm(r["Hearing Required"]) === norm(req.query.hearing_required),
    );
  }
  res.json(paginate(results, req));
});

// GET /api/az/violations/:unit
app.get("/api/az/violations/:unit", (req, res) => {
  const records = db.az_violations.filter((r) => norm(r.Unit) === norm(req.params.unit));
  res.json({ unit: req.params.unit, violations: records });
});

// ── Azure Bay: Work Orders ────────────────────────────────────────────────────

// GET /api/az/work-orders?status=Open&priority=High&category=...
app.get("/api/az/work-orders", (req, res) => {
  let results = db.az_work_orders;
  if (req.query.status) {
    results = results.filter((r) => norm(r.Status) === norm(req.query.status));
  }
  if (req.query.priority) {
    results = results.filter((r) => norm(r.Priority) === norm(req.query.priority));
  }
  if (req.query.category) {
    results = results.filter((r) => norm(r.Category).includes(norm(req.query.category)));
  }
  if (req.query.unit) {
    results = results.filter((r) => norm(r["Unit (blank=common)"]) === norm(req.query.unit));
  }
  if (req.query.vendor) {
    results = results.filter((r) => norm(r.Vendor).includes(norm(req.query.vendor)));
  }
  res.json(paginate(results, req));
});

// GET /api/az/work-orders/:id
app.get("/api/az/work-orders/:id", (req, res) => {
  const wo = db.az_work_orders.find((r) => norm(r["Work Order ID"]) === norm(req.params.id));
  if (!wo) {
    return res.status(404).json({ error: "Work order not found" });
  }
  res.json(wo);
});

// ── Azure Bay: Parking & Boat Slips ──────────────────────────────────────────

// GET /api/az/parking/:unit
app.get("/api/az/parking/:unit", (req, res) => {
  const records = db.az_parking.filter((r) => norm(r["Assigned Unit"]) === norm(req.params.unit));
  res.json({ unit: req.params.unit, parking_spaces: records });
});

// GET /api/az/boat-slips/:unit
app.get("/api/az/boat-slips/:unit", (req, res) => {
  const records = db.az_boatslips.filter((r) => norm(r["Assigned Unit"]) === norm(req.params.unit));
  res.json({ unit: req.params.unit, boat_slips: records });
});

// ── Azure Bay: Vendors ────────────────────────────────────────────────────────

// GET /api/az/vendors?category=...
app.get("/api/az/vendors", (req, res) => {
  let results = db.az_vendors;
  if (req.query.category) {
    results = results.filter((r) => norm(r.Category).includes(norm(req.query.category)));
  }
  res.json({ total: results.length, vendors: results });
});

// ── Azure Bay: Notices ────────────────────────────────────────────────────────

// GET /api/az/notices?category=...&delivery=SMS
app.get("/api/az/notices", (req, res) => {
  let results = db.az_notices;
  if (req.query.category) {
    results = results.filter((r) => norm(r.Category).includes(norm(req.query.category)));
  }
  if (req.query.delivery) {
    results = results.filter((r) => norm(r.Delivery) === norm(req.query.delivery));
  }
  res.json({ total: results.length, notices: results });
});

// ── Azure Bay: Identity Resolution ───────────────────────────────────────────

// POST /api/az/identity/resolve  — { phone, email }
app.post("/api/az/identity/resolve", (req, res) => {
  const { phone, email } = req.body || {};
  if (!phone && !email) {
    return res.status(400).json({ error: "Provide phone or email" });
  }

  const candidates = [];

  db.az_units.forEach((r) => {
    const phoneHit = phone && phoneMatch(r["Owner Phone"], phone);
    const emailHit = email && emailMatch(r["Owner Email"], email);
    if (phoneHit || emailHit) {
      candidates.push({
        subject_id: `az_owner_${norm(r.Unit)}`,
        role: r["Occupancy Type"] === "Tenant" ? "renter" : "owner",
        name: r["Owner Name"] || r["Tenant Name"],
        unit_id: r.Unit,
        property: "Azure Bay Residences",
        match_by: phoneHit ? "phone" : "email",
        verification_state: "soft_match",
        sms_opt_in: r["SMS Opt-In"] === "Y",
      });
    }
  });

  const ambiguous = candidates.length > 1;
  res.json({
    channel_identity: { type: phone ? "sms" : "email", value: phone || email },
    candidate_count: candidates.length,
    subject_candidates: candidates,
    active_subject: null,
    decision:
      candidates.length === 0
        ? "no_match"
        : ambiguous
          ? "ask_clarification"
          : "allow_with_verification",
    note: ambiguous
      ? "Multiple subjects found. active_subject must be explicitly selected before protected resolvers execute."
      : candidates.length === 0
        ? "No matching resident found for this contact."
        : "Single candidate found. Proceed to verification before protected reads.",
  });
});

// ── Azure Bay: PM Summary ─────────────────────────────────────────────────────

// GET /api/az/pm/summary
app.get("/api/az/pm/summary", (req, res) => {
  const accounts = db.az_accounts;
  const violations = db.az_violations;
  const work_orders = db.az_work_orders;

  // AR / delinquency breakdown
  const buckets = {};
  let total_ar = 0;
  let special_assessment_units = 0;
  accounts.forEach((r) => {
    const bal = r["Current Balance ($)"] || 0;
    total_ar += bal;
    const bucket = r["Delinquency Bucket [Formula]"] || "Unknown";
    buckets[bucket] = (buckets[bucket] || 0) + 1;
    if (r["Special Assessment Active"] === "Y") {
      special_assessment_units++;
    }
  });

  // Violations
  const vByStatus = {};
  violations.forEach((r) => {
    vByStatus[r.Status] = (vByStatus[r.Status] || 0) + 1;
  });

  // Work orders
  const woByStatus = {};
  work_orders.forEach((r) => {
    woByStatus[r.Status] = (woByStatus[r.Status] || 0) + 1;
  });
  const open_wo = work_orders.filter((r) => r.Status === "Open").length;

  res.json({
    property: "Azure Bay Residences",
    total_units: db.az_units.length,
    as_of: "2026-03-10",
    financials: {
      total_ar: Math.round(total_ar * 100) / 100,
      delinquency_buckets: buckets,
      special_assessment_units,
    },
    violations: {
      total: violations.length,
      by_status: vByStatus,
    },
    work_orders: {
      total: work_orders.length,
      open: open_wo,
      by_status: woByStatus,
    },
    amenities: {
      parking_spaces: db.az_parking.length,
      boat_slips: db.az_boatslips.length,
    },
    vendors: db.az_vendors.length,
  });
});

// ── Azure Bay: SMS Test Scenarios ─────────────────────────────────────────────

// GET /api/az/test-scenarios?unit=...
app.get("/api/az/test-scenarios", (req, res) => {
  let results = db.az_sms_tests;
  if (req.query.unit) {
    results = results.filter((r) => norm(r.Unit) === norm(req.query.unit));
  }
  res.json({ total: results.length, scenarios: results });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found", path: req.path });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\nAppFolio Pseudo-API running at http://127.0.0.1:${PORT}`);
  console.log(`Docs: http://127.0.0.1:${PORT}/\n`);
});
