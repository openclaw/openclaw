#!/usr/bin/env node
/**
 * ERP Secure Query
 *
 * Enforces WeCom user ACL before running ERP queries.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const POLICY_PATH = path.join(ROOT, "policy", "acl-policy.json");
const QUERY_SCRIPT = path.join(__dirname, "query.cjs");
const QUICK_QUERY_SCRIPT = path.join(__dirname, "quick-query.cjs");
const NO_PERMISSION_MESSAGE = "当前没有权限。";

function usage() {
  console.log(`
ERP Secure Query

Usage:
  node secure-query.cjs --wecom-user-id <id> sql "SELECT ..."
  node secure-query.cjs --wecom-user-id <id> supplier <supId> [--aging] [--recent N] [--year YYYY] [--json]
  node secure-query.cjs --wecom-user-id <id> permissions

Notes:
  - Requires ACL policy file: ${POLICY_PATH}
  - SQL mode only accepts read-only SELECT/WITH queries.
`);
}

function getOption(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return null;
  }
  return args[idx + 1] ?? null;
}

function removeOption(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return args.slice();
  }
  const next = args.slice();
  next.splice(idx, 2);
  return next;
}

function normalizeUserId(userId) {
  return String(userId || "")
    .trim()
    .toLowerCase();
}

function normalizePolicyUsers(policy) {
  const users = policy.users || {};
  const normalized = {};
  const canonicalKeys = new Set(
    Object.keys(users).filter((rawId) => rawId && rawId === normalizeUserId(rawId)),
  );

  for (const [rawId, user] of Object.entries(users)) {
    const normalizedId = normalizeUserId(rawId);
    if (!normalizedId) {
      continue;
    }
    const current = normalized[normalizedId] || {
      displayName: "",
      roles: [],
      status: "active",
      note: "",
      updatedAt: null,
    };
    const preferThisRoles = !canonicalKeys.has(normalizedId) || rawId === normalizedId;
    if (preferThisRoles) {
      current.roles = [
        ...new Set((user.roles || []).map((item) => String(item).trim()).filter(Boolean)),
      ].sort();
    }
    if (!current.displayName && user.displayName) {
      current.displayName = String(user.displayName).trim();
    }
    if (!current.note && user.note) {
      current.note = String(user.note);
    }
    if (user.status) {
      current.status = String(user.status);
    }
    if (user.updatedAt && String(user.updatedAt) > String(current.updatedAt || "")) {
      current.updatedAt = String(user.updatedAt);
    }
    normalized[normalizedId] = current;
  }

  policy.users = normalized;
}

function normalizeTableName(name) {
  const plain = name.replace(/[[\]`"]/g, "");
  const parts = plain.split(".");
  return parts[parts.length - 1].toLowerCase();
}

function extractTables(sqlText) {
  const tables = new Set();
  const regex = /(?:from|join)\s+([a-zA-Z_][\w.[\]]*)/gi;
  let m;
  while ((m = regex.exec(sqlText)) !== null) {
    tables.add(normalizeTableName(m[1]));
  }
  return tables;
}

function extractVoucherTypes(sqlText) {
  const types = new Set();

  const equalRegex = /(?:ref_)?voucher_type\s*=\s*'([A-Za-z0-9]{2,3})'/gi;
  let m;
  while ((m = equalRegex.exec(sqlText)) !== null) {
    types.add(String(m[1]).toUpperCase());
  }

  const inRegex = /(?:ref_)?voucher_type\s+in\s*\(([^)]+)\)/gi;
  while ((m = inRegex.exec(sqlText)) !== null) {
    const content = m[1];
    const codeRegex = /'([A-Za-z0-9]{2,3})'/g;
    let c;
    while ((c = codeRegex.exec(content)) !== null) {
      types.add(String(c[1]).toUpperCase());
    }
  }

  return types;
}

function ensureReadOnlySql(sqlText) {
  const trimmed = sqlText.trim();
  if (!trimmed) {
    throw new Error("SQL is empty.");
  }
  const startsReadOnly = /^(select|with)\b/i.test(trimmed);
  if (!startsReadOnly) {
    throw new Error("Only SELECT/WITH queries are allowed.");
  }
  const writePattern = /\b(insert|update|delete|drop|alter|truncate|create|merge|exec|execute)\b/i;
  if (writePattern.test(trimmed)) {
    throw new Error("Write/DDL SQL is forbidden.");
  }
}

function loadPolicy() {
  if (!fs.existsSync(POLICY_PATH)) {
    throw new Error(`Policy file not found: ${POLICY_PATH}`);
  }
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
  normalizePolicyUsers(policy);
  return policy;
}

function resolvePermissions(policy, wecomUserId) {
  const users = policy.users || {};
  const resolvedUserId = normalizeUserId(wecomUserId);
  const user = users[resolvedUserId];

  if (!user) {
    throw new Error(`User ${wecomUserId} has no ACL entry.`);
  }
  const roles = user.roles || [];
  if (roles.length === 0) {
    throw new Error(`User ${wecomUserId} has no roles.`);
  }

  const voucherTypes = new Set();
  const tables = new Set();
  let allowAllTables = false;
  let requireVoucherTypeFilter = false;

  for (const roleId of roles) {
    const role = policy.roles?.[roleId];
    if (!role) {
      continue;
    }
    for (const item of role.allowedVoucherTypes || []) {
      voucherTypes.add(String(item).toUpperCase());
    }
    for (const item of role.allowedTables || []) {
      if (item === "*") {
        allowAllTables = true;
      } else {
        tables.add(String(item).toLowerCase());
      }
    }
    if (role.requireVoucherTypeFilter) {
      requireVoucherTypeFilter = true;
    }
  }

  return {
    user,
    resolvedUserId,
    roles,
    voucherTypes,
    tables,
    allowAllTables,
    requireVoucherTypeFilter,
  };
}

function enforceSqlAcl(sqlText, permission) {
  ensureReadOnlySql(sqlText);

  const tables = extractTables(sqlText);
  if (!permission.allowAllTables) {
    for (const table of tables) {
      if (!permission.tables.has(table)) {
        throw new Error(`Table "${table}" is not allowed for this user.`);
      }
    }
  }

  const voucherTypes = extractVoucherTypes(sqlText);
  for (const type of voucherTypes) {
    if (!permission.voucherTypes.has(type)) {
      throw new Error(`voucher_type "${type}" is not allowed for this user.`);
    }
  }

  const controlledTables = new Set(["ebs_v", "ebs_vr", "ebs_vr_item", "eba_io", "sup_io"]);
  const touchesControlledTables = [...tables].some((table) => controlledTables.has(table));

  if (permission.requireVoucherTypeFilter && touchesControlledTables && voucherTypes.size === 0) {
    throw new Error(
      "SQL touching voucher tables must include explicit voucher_type/ref_voucher_type filters.",
    );
  }
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync("node", [scriptPath, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      ERP_ACL_TRUSTED: "1",
    },
  });
  process.exit(result.status ?? 1);
}

function showPermissions(permission, wecomUserId) {
  console.log(
    JSON.stringify(
      {
        wecomUserId,
        displayName: permission.user.displayName || "",
        roles: permission.roles,
        allowedVoucherTypes: [...permission.voucherTypes].sort(),
        allowedTables: permission.allowAllTables ? ["*"] : [...permission.tables].sort(),
        requireVoucherTypeFilter: permission.requireVoucherTypeFilter,
      },
      null,
      2,
    ),
  );
}

function isPermissionDeniedError(message) {
  return [
    /has no ACL entry\./i,
    /has no roles\./i,
    /is not allowed for this user\./i,
    /must include explicit voucher_type\/ref_voucher_type filters\./i,
    /does not have procurement voucher permissions\./i,
    /当前没有权限。/i,
  ].some((pattern) => pattern.test(message));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  try {
    const userId = getOption(args, "--wecom-user-id");
    if (!userId) {
      throw new Error("Missing --wecom-user-id <id>.");
    }
    const cleanArgs = removeOption(args, "--wecom-user-id");
    const command = cleanArgs[0];
    if (!command) {
      throw new Error("Missing command.");
    }

    const policy = loadPolicy();
    const permission = resolvePermissions(policy, userId);

    if (command === "permissions") {
      showPermissions(permission, userId);
      return;
    }

    if (command === "sql") {
      const sqlText = cleanArgs.slice(1).join(" ").trim();
      if (!sqlText) {
        throw new Error('Usage: sql "SELECT ..."');
      }
      enforceSqlAcl(sqlText, permission);
      runNodeScript(QUERY_SCRIPT, [sqlText]);
      return;
    }

    if (command === "supplier") {
      const supplierId = cleanArgs[1];
      if (!supplierId) {
        throw new Error("Usage: supplier <supId> [--aging] [--recent N] [--year YYYY] [--json]");
      }
      const hasProcurementPermission = ["AA", "AB", "AC", "AF", "AI"].some((type) =>
        permission.voucherTypes.has(type),
      );
      if (!hasProcurementPermission) {
        throw new Error("User does not have procurement voucher permissions.");
      }
      runNodeScript(QUICK_QUERY_SCRIPT, cleanArgs);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (err) {
    const message = String(err?.message || err || "");
    if (isPermissionDeniedError(message)) {
      console.error(`Error: ${NO_PERMISSION_MESSAGE}`);
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }
}

main();
