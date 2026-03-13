import fs from "fs";
// ...existing code...
// Minimal Express server for test-scenarios and triage endpoints
// ...existing code...
// ...existing code...
// GET /api/az/accounts/phone/:phone
import express from "express";
import xlsx from "xlsx";
const app = express();
const PORT = 3740;

// Individual endpoints for remaining Accounts_AR columns
// /api/az/accounts/:unit/payment-method
app.get("/api/az/accounts/:unit/payment-method", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, paymentMethod: account["Payment Method"] });
});

// /api/az/accounts/:unit/last-assessment-due-date
app.get("/api/az/accounts/:unit/last-assessment-due-date", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, lastAssessmentDueDate: account["Last Assessment Due Date"] });
});

// /api/az/accounts/:unit/days-past-due
app.get("/api/az/accounts/:unit/days-past-due", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, daysPastDue: account["Days Past Due [Formula]"] });
});

// /api/az/accounts/:unit/delinquency-bucket
app.get("/api/az/accounts/:unit/delinquency-bucket", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, delinquencyBucket: account["Delinquency Bucket [Formula]"] });
});

// /api/az/accounts/:unit/late-fees
app.get("/api/az/accounts/:unit/late-fees", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, lateFees: account["Late Fees ($)"] });
});

// /api/az/accounts/:unit/payment-plan
app.get("/api/az/accounts/:unit/payment-plan", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, paymentPlan: account["Payment Plan"] });
});

// /api/az/accounts/:unit/autopay
app.get("/api/az/accounts/:unit/autopay", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, autopay: account["Autopay"] });
});
// Helper: List of all Accounts_AR columns
const accountsARColumns = [
  "Unit",
  "Account Holder (Owner)",
  "Monthly Assessment ($)",
  "Annual Assessment ($) [Formula]",
  "Special Assessment Active",
  "Special Assessment Balance ($)",
  "Current Balance ($)",
  "Last Payment Date",
  "Last Payment Amount ($)",
  "Payment Method",
  "Last Assessment Due Date",
  "Days Past Due [Formula]",
  "Delinquency Bucket [Formula]",
  "Late Fees ($)",
  "Payment Plan",
  "Autopay",
];

// Generic endpoint for any Accounts_AR column by unit
app.get("/api/az/accounts/:unit/column/:column", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  const col = accountsARColumns.find(
    (c) => c.toLowerCase() === req.params.column.replace(/_/g, " ").toLowerCase(),
  );
  if (!col) {
    return res.status(400).json({ error: "Unknown column" });
  }
  res.json({ unit: req.params.unit, column: col, value: account[col] });
});

// Convenience endpoints for each column
accountsARColumns.forEach((col) => {
  const endpoint =
    "/api/az/accounts/:unit/" +
    col
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  app.get(endpoint, (req, res) => {
    const account = findAccountByUnit(req.params.unit);
    if (!account) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ unit: req.params.unit, [col]: account[col] });
  });
});
// Helper to find account row by unit
function findAccountByUnit(unit) {
  return excelAccounts.find((a) => {
    return (
      (a["Unit"] && String(a["Unit"]).trim().toLowerCase() === unit.trim().toLowerCase()) ||
      (a["unit"] && String(a["unit"]).trim().toLowerCase() === unit.trim().toLowerCase())
    );
  });
}

// GET /api/az/accounts/:unit/monthly-assessment
app.get("/api/az/accounts/:unit/monthly-assessment", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, monthlyAssessment: account["Monthly Assessment ($)"] });
});

// GET /api/az/accounts/:unit/annual-assessment
app.get("/api/az/accounts/:unit/annual-assessment", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, annualAssessment: account["Annual Assessment ($) [Formula]"] });
});

// GET /api/az/accounts/:unit/special-assessment-active
app.get("/api/az/accounts/:unit/special-assessment-active", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({
    unit: req.params.unit,
    specialAssessmentActive: account["Special Assessment Active"],
  });
});

// GET /api/az/accounts/:unit/special-assessment-balance
app.get("/api/az/accounts/:unit/special-assessment-balance", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({
    unit: req.params.unit,
    specialAssessmentBalance: account["Special Assessment Balance ($)"],
  });
});

// GET /api/az/accounts/:unit/last-payment-date
app.get("/api/az/accounts/:unit/last-payment-date", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, lastPaymentDate: account["Last Payment Date"] });
});

// GET /api/az/accounts/:unit/last-payment-amount
app.get("/api/az/accounts/:unit/last-payment-amount", (req, res) => {
  const account = findAccountByUnit(req.params.unit);
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ unit: req.params.unit, lastPaymentAmount: account["Last Payment Amount ($)"] });
});
// GET /api/az/accounts/email/:email
app.get("/api/az/accounts/email/:email", (req, res) => {
  const emailParam = req.params.email.trim().toLowerCase();
  // Common email field names
  const emailFields = ["Owner Email", "Email"];
  if (emailParam.toUpperCase() === "ALL") {
    // Return all accounts with any email
    const allWithEmail = excelAccounts.filter((a) =>
      emailFields.some((field) => a[field] && String(a[field]).trim().length > 0),
    );
    return res.json(allWithEmail);
  }
  const account = excelAccounts.find((a) => {
    for (const field of emailFields) {
      if (a[field] && String(a[field]).trim().toLowerCase() === emailParam) {
        return true;
      }
    }
    return false;
  });
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(account);
});

app.use(express.json());

// Load scenarios from az_sms_tests.json if available
let scenarios = [];
try {
  scenarios = JSON.parse(fs.readFileSync("../data/az_sms_tests.json", "utf8"));
} catch {
  scenarios = [];
}

// Load account data from Excel using absolute path
const excelPath =
  "/Users/cliffordvaughn/AskTenant Workspace/openclaw/Azure_Bay_Residences_Demo_Data_850_Units.xlsx";
let excelAccounts = [];
try {
  console.log("Loading Excel data from:", excelPath);
  const workbook = xlsx.readFile(excelPath);
  excelAccounts = [];
  const allKeys = new Set();
  // Store all rows by sheet for generic tab endpoints
  global.sheetRows = {};
  for (const sheetName of workbook.SheetNames) {
    // Always skip README and Assumptions tabs
    if (["readme", "assumptions"].includes(sheetName.trim().toLowerCase())) {
      console.warn(`Skipping all endpoints for reserved sheet: '${sheetName}'`);
      continue;
    }
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);
    if (rows.length > 0) {
      Object.keys(rows[0]).forEach((k) => allKeys.add(k));
      console.log(`Sheet '${sheetName}' keys:`, Object.keys(rows[0]));
      console.log(`Sheet '${sheetName}' first 2 rows:`, rows.slice(0, 2));
      global.sheetRows[sheetName] = rows;
    }
    excelAccounts.push(...rows);
  }
  console.log("All unique field names across all sheets:", Array.from(allKeys));
  // Auto-generate endpoints for every column in every sheet/tab, but skip problematic names
  const isSafeForRoute = (name) => {
    // Exclude names with parentheses, em/en dashes, or other problematic chars
    return /^[a-zA-Z0-9 _-]+$/.test(name) && !/[()—–]/.test(name);
  };
  Object.entries(global.sheetRows || {}).forEach(([sheetName, rows]) => {
    if (!rows.length) {
      return;
    }
    if (!isSafeForRoute(sheetName)) {
      console.warn(`Skipping all endpoints for sheet with problematic name: '${sheetName}'`);
      return;
    }
    const columns = Object.keys(rows[0]);
    let keyField = columns[0];
    const tabSlug = sheetName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    // Special case for Amenities_Parking: use 'Assigned Unit' as key
    if (tabSlug === "amenities-parking" && columns.includes("Assigned Unit")) {
      keyField = "Assigned Unit";
    }
    columns.forEach((col) => {
      if (!isSafeForRoute(col)) {
        console.warn(`Skipping column with problematic name: '${col}' in sheet '${sheetName}'`);
        return;
      }
      const colSlug = col
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const endpoint =
        `/api/az/${tabSlug}/:${keyField.toLowerCase().replace(/ /g, "-")}/` + colSlug;
      app.get(endpoint, (req, res) => {
        const value = req.params[keyField.toLowerCase().replace(/ /g, "-")];
        const row = rows.find(
          (r) =>
            r[keyField] && String(r[keyField]).trim().toLowerCase() === value.trim().toLowerCase(),
        );
        if (!row) {
          return res.status(404).json({ error: "Not found" });
        }
        res.json({ [keyField]: value, [col]: row[col] });
      });
    });
    // Only add a generic column endpoint for safe sheets, and only once per sheet
    app.get(
      `/api/az/${tabSlug}/:${keyField.toLowerCase().replace(/ /g, "-")}/column/:column`,
      (req, res) => {
        const value = req.params[keyField.toLowerCase().replace(/ /g, "-")];
        const col = columns.find(
          (c) => c.toLowerCase() === req.params.column.replace(/_/g, " ").toLowerCase(),
        );
        if (!col || !isSafeForRoute(col)) {
          return res.status(400).json({ error: "Unknown or unsafe column" });
        }
        const row = rows.find(
          (r) =>
            r[keyField] && String(r[keyField]).trim().toLowerCase() === value.trim().toLowerCase(),
        );
        if (!row) {
          return res.status(404).json({ error: "Not found" });
        }
        res.json({ [keyField]: value, [col]: row[col] });
      },
    );
  });
  if (excelAccounts.length === 0) {
    console.log("Excel file loaded but no data found in any sheet.");
  }
} catch (e) {
  console.error("Failed to load Excel data:", e);
}

// GET /api/az/test-scenarios
app.get("/api/az/test-scenarios", (req, res) => {
  res.json(scenarios);
});

app.get("/api/az/accounts/phone/:phone", (req, res) => {
  const phoneParam = req.params.phone;
  // Common phone field names (expanded)
  const phoneFields = [
    "Phone",
    "Phone Number",
    "Resident Phone",
    "Primary Phone",
    "Contact Phone",
    "phone",
    "phone_number",
    "ResidentPhone",
    "Owner_Phone",
    "Owner Phone",
  ];
  if (phoneParam.toUpperCase() === "ALL") {
    // Return all accounts with any phone number
    const allWithPhone = excelAccounts.filter((a) =>
      phoneFields.some((field) => a[field] && String(a[field]).replace(/\D/g, "").length > 0),
    );
    return res.json(allWithPhone);
  }
  const phone = phoneParam.replace(/\D/g, ""); // digits only
  const account = excelAccounts.find((a) => {
    for (const field of phoneFields) {
      if (a[field]) {
        const digits = String(a[field]).replace(/\D/g, "");
        if (digits.endsWith(phone) || digits === phone) {
          return true;
        }
      }
    }
    return false;
  });
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(account);
});

// POST /api/az/identity/resolve
app.post("/api/az/identity/resolve", (req, res) => {
  // Demo: always return no_match (extend as needed)
  res.json({
    decision: "no_match",
    subject_candidates: [],
    candidate_count: 0,
  });
});

// GET /api/az/accounts/:unit
app.get("/api/az/accounts/:unit", (req, res) => {
  const unit = req.params.unit.trim().toLowerCase();
  // Common field names for unit number
  const unitFields = [
    "Unit",
    "Unit #",
    "Unit Number",
    "UnitNumber",
    "Unit#",
    "unit",
    "unit_id",
    "unit number",
  ];
  const account = excelAccounts.find((a) => {
    for (const field of unitFields) {
      if (a[field] && String(a[field]).trim().toLowerCase() === unit) {
        return true;
      }
    }
    // Fallback: check all fields
    return Object.values(a).some((v) => String(v).trim().toLowerCase() === unit);
  });
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(account);
});

// GET /api/az/units/:unit
app.get("/api/az/units/:unit", (req, res) => {
  const unit = req.params.unit;
  const unitObj = az_units.find((u) => u.unit_id == unit || u.unit == unit);
  if (!unitObj) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(unitObj);
});

// GET /api/az/work-orders
app.get("/api/az/work-orders", (req, res) => {
  const unit = req.query.unit;
  let results = az_work_orders;
  if (unit) {
    results = results.filter((w) => w.unit_id == unit || w.unit == unit);
  }
  res.json({ results });
});

// GET /api/az/violations/:unit
app.get("/api/az/violations/:unit", (req, res) => {
  const unit = req.params.unit;
  const violations = az_violations.filter((v) => v.unit_id == unit || v.unit == unit);
  res.json({ violations });
});

// POST /api/triage
app.post("/api/triage", (req, res) => {
  // For now, just echo back the message or expected field
  const { message } = req.body;
  res.json({ answer: message });
});

app.listen(PORT, () => {
  console.log(`API server running on http://127.0.0.1:${PORT}`);
});
