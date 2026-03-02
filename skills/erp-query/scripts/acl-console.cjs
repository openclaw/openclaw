#!/usr/bin/env node
/**
 * ERP ACL Console
 *
 * Manage role-based access control for erp-query skill.
 * Principal: WeCom user id (wx_oit_id)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("/Users/haruki/.openclaw/workspace/node_modules/mssql");

const DB_CONFIG = {
  server: "192.168.3.250",
  user: "OpenClaw_Reader",
  password: "SafePass_2026!",
  database: "htjx2021",
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 10000,
  requestTimeout: 60000,
  pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
};

const ROOT = path.resolve(__dirname, "..");
const POLICY_DIR = path.join(ROOT, "policy");
const POLICY_PATH = path.join(POLICY_DIR, "acl-policy.json");
const MUTATING_COMMANDS = new Set([
  "init",
  "sync-forms",
  "sync-users",
  "assign",
  "unassign",
  "set-mutation-secret",
]);

const CONTROLLED_GROUPS = ["eba", "sup", "emf", "edt", "ebm", "mio", "qm", "timer", "wage", "emp"];

const DEFAULT_ROLE_TABLES = {
  sales_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "eba", "eba_io", "res"],
  procurement_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "sup", "sup_io", "res"],
  production_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "res", "edt_res"],
  warehouse_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "edt_res", "res"],
  finance_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "ebm_mio", "ebm_mio_item", "eba", "sup"],
  quality_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "res"],
  hr_manager: ["ebs_v", "ebs_vr", "ebs_vr_item", "app_emp"],
  admin_readonly: ["*"],
};

function nowIso() {
  return new Date().toISOString();
}

function ensurePolicyDir() {
  fs.mkdirSync(POLICY_DIR, { recursive: true });
}

function usage() {
  console.log(`
ERP ACL Console

Usage:
  node acl-console.cjs init [--force] --operator-wecom-user-id <adminUserId> --mutation-secret <secret>
  node acl-console.cjs sync-forms --operator-wecom-user-id <adminUserId> --mutation-secret <secret>
  node acl-console.cjs sync-users --operator-wecom-user-id <adminUserId> --mutation-secret <secret>
  node acl-console.cjs list-roles
  node acl-console.cjs list-users
  node acl-console.cjs list-admins
  node acl-console.cjs list-forms [--group <group>] [--active-only]
  node acl-console.cjs assign <wecomUserId> <roleId> [--name <displayName>] --operator-wecom-user-id <adminUserId> --mutation-secret <secret>
  node acl-console.cjs unassign <wecomUserId> <roleId> --operator-wecom-user-id <adminUserId> --mutation-secret <secret>
  node acl-console.cjs set-mutation-secret --operator-wecom-user-id <adminUserId> --new-mutation-secret <newSecret> [--mutation-secret <currentSecret>]
  node acl-console.cjs show <wecomUserId>

Policy file:
  ${POLICY_PATH}

Notes:
  - Mutating commands require --operator-wecom-user-id.
  - Mutating commands require --mutation-secret (except first-time set-mutation-secret).
  - Only ACL admins can mutate policy. Admins are users in "aclAdmins" or users with role "admin_readonly".
  - Mutation secret is stored as sha256 hash in policy (no plaintext persistence).
  - First-time mutation secret setup uses: set-mutation-secret --new-mutation-secret <secret>.
`);
}

function getFlag(args, name) {
  return args.includes(name);
}

function getOption(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return null;
  }
  return args[idx + 1] ?? null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function hashMutationSecret(secret) {
  return crypto
    .createHash("sha256")
    .update(String(secret || ""), "utf8")
    .digest("hex");
}

function normalizeSecretHash(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(raw) ? raw : "";
}

function validateMutationSecretStrength(secret) {
  const raw = String(secret || "");
  if (raw.length < 10) {
    throw new Error("mutation secret is too short (minimum 10 characters).");
  }
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
      updatedAt: nowIso(),
    };
    const preferThisRoles = !canonicalKeys.has(normalizedId) || rawId === normalizedId;
    if (preferThisRoles) {
      current.roles = uniqueSorted(
        (user.roles || []).map((item) => String(item).trim()).filter(Boolean),
      );
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

function ensureUserRecord(policy, userId) {
  policy.users = policy.users || {};
  if (!policy.users[userId]) {
    policy.users[userId] = {
      displayName: "",
      roles: [],
      status: "active",
      note: "",
      updatedAt: nowIso(),
    };
  }
  return policy.users[userId];
}

function resolveAclAdmins(policy) {
  const fromConfig = Array.isArray(policy.aclAdmins)
    ? policy.aclAdmins.map((id) => normalizeUserId(id)).filter(Boolean)
    : [];
  const fromRole = Object.entries(policy.users || {})
    .filter(([, user]) => Array.isArray(user.roles) && user.roles.includes("admin_readonly"))
    .map(([userId]) => normalizeUserId(userId))
    .filter(Boolean);
  return uniqueSorted([...fromConfig, ...fromRole]);
}

function bootstrapAclAdminIfNeeded(policy, operatorUserId) {
  const admins = resolveAclAdmins(policy);
  if (admins.length > 0) {
    return admins;
  }

  const normalizedOperator = normalizeUserId(operatorUserId);
  if (!normalizedOperator) {
    throw new Error(
      "No ACL admin is configured. Provide --operator-wecom-user-id <id> to bootstrap first admin.",
    );
  }

  const user = ensureUserRecord(policy, normalizedOperator);
  const roles = new Set(user.roles || []);
  roles.add("admin_readonly");
  user.roles = [...roles].sort();
  user.updatedAt = nowIso();
  policy.aclAdmins = uniqueSorted([
    ...(Array.isArray(policy.aclAdmins) ? policy.aclAdmins : []),
    normalizedOperator,
  ]);
  savePolicy(policy);
  console.log(`bootstrapped ACL admin: ${normalizedOperator}`);
  return resolveAclAdmins(policy);
}

function requireAclAdminForMutation(policy, command, operatorUserId) {
  const normalizedOperator = normalizeUserId(operatorUserId);
  if (!normalizedOperator) {
    throw new Error(`Command "${command}" requires --operator-wecom-user-id <adminUserId>.`);
  }
  const admins = bootstrapAclAdminIfNeeded(policy, normalizedOperator);
  if (!admins.includes(normalizedOperator)) {
    throw new Error(
      `Operator "${normalizedOperator}" is not allowed to mutate ACL. Allowed admins: ${admins.join(", ")}`,
    );
  }
  return normalizedOperator;
}

function requireMutationSecretForCommand(policy, command, mutationSecret) {
  const configuredHash = normalizeSecretHash(policy.aclMutationSecretHash);
  if (!configuredHash) {
    throw new Error(
      "Mutation secret is not configured. Run: set-mutation-secret --operator-wecom-user-id <adminUserId> --new-mutation-secret <secret>",
    );
  }
  const provided = String(mutationSecret || "").trim();
  if (!provided) {
    throw new Error(`Command "${command}" requires --mutation-secret <secret>.`);
  }
  const providedHash = hashMutationSecret(provided);
  if (providedHash !== configuredHash) {
    throw new Error("Invalid mutation secret.");
  }
}

function loadPolicy() {
  if (!fs.existsSync(POLICY_PATH)) {
    throw new Error(`Policy not found: ${POLICY_PATH}. Run "init" first.`);
  }
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
  normalizePolicyUsers(policy);
  policy.aclMutationSecretHash = normalizeSecretHash(policy.aclMutationSecretHash);
  policy.aclAdmins = uniqueSorted(
    (Array.isArray(policy.aclAdmins) ? policy.aclAdmins : [])
      .map((id) => normalizeUserId(id))
      .filter(Boolean),
  );
  return policy;
}

function savePolicy(policy) {
  ensurePolicyDir();
  policy.updatedAt = nowIso();
  fs.writeFileSync(POLICY_PATH, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}

async function withDb(callback) {
  const pool = await sql.connect(DB_CONFIG);
  try {
    return await callback(pool);
  } finally {
    try {
      await pool.close();
    } catch (_) {}
  }
}

async function fetchFormsFromDb() {
  const query = `
    SELECT
      av.voucher_group_id AS voucherGroup,
      av.voucher_type AS voucherType,
      av.voucher_name AS voucherName,
      av.stop_flag AS stopFlag,
      ISNULL(v.cnt, 0) AS usedCount,
      v.last_date AS lastDate
    FROM app_voucher_type av
    LEFT JOIN (
      SELECT voucher_type, COUNT(*) AS cnt, MAX(voucher_date) AS last_date
      FROM ebs_v
      GROUP BY voucher_type
    ) v ON av.voucher_type = v.voucher_type
    WHERE av.voucher_group_id <> 'vir'
    ORDER BY av.voucher_group_id, av.voucher_type
  `;

  return withDb(async (pool) => {
    const result = await pool.request().query(query);
    return result.recordset.map((row) => ({
      voucherGroup: String(row.voucherGroup || "").trim(),
      voucherType: String(row.voucherType || "")
        .trim()
        .toUpperCase(),
      voucherName: String(row.voucherName || "").trim(),
      stopFlag: String(row.stopFlag || "N")
        .trim()
        .toUpperCase(),
      usedCount: Number(row.usedCount || 0),
      lastDate: row.lastDate ? String(row.lastDate) : null,
    }));
  });
}

async function fetchWecomUsersFromDb() {
  const query = `
    SELECT wx_oit_id AS userId, key_id AS displayName
    FROM app_wx_map
    WHERE obj_id = 'user' AND wx_oit_id IS NOT NULL
  `;

  return withDb(async (pool) => {
    const result = await pool.request().query(query);
    return result.recordset
      .map((row) => ({
        userId: String(row.userId || "").trim(),
        displayName: String(row.displayName || "").trim(),
      }))
      .filter((item) => item.userId.length > 0);
  });
}

function buildVoucherTypesByGroups(forms, groups) {
  return uniqueSorted(
    forms
      .filter((item) => item.stopFlag !== "Y" && groups.includes(item.voucherGroup))
      .map((item) => item.voucherType),
  );
}

function buildDefaultRoles(forms) {
  return {
    sales_manager: {
      description: "销售主管：销售单据与客户相关查询",
      autoGroups: ["eba"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["eba"]),
      allowedTables: DEFAULT_ROLE_TABLES.sales_manager,
      requireVoucherTypeFilter: true,
    },
    procurement_manager: {
      description: "采购主管：采购单据与供应商相关查询",
      autoGroups: ["sup"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["sup"]),
      allowedTables: DEFAULT_ROLE_TABLES.procurement_manager,
      requireVoucherTypeFilter: true,
    },
    production_manager: {
      description: "生产主管：生产与库存流转查询",
      autoGroups: ["emf", "edt"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["emf", "edt"]),
      allowedTables: DEFAULT_ROLE_TABLES.production_manager,
      requireVoucherTypeFilter: true,
    },
    warehouse_manager: {
      description: "仓储主管：库存、移库、盘点、出入库查询",
      autoGroups: ["edt"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["edt"]),
      allowedTables: DEFAULT_ROLE_TABLES.warehouse_manager,
      requireVoucherTypeFilter: true,
    },
    finance_manager: {
      description: "财务主管：收付款、核销、资金流水查询",
      autoGroups: ["ebm", "mio"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["ebm", "mio"]),
      allowedTables: DEFAULT_ROLE_TABLES.finance_manager,
      requireVoucherTypeFilter: true,
    },
    quality_manager: {
      description: "质检主管：质量相关单据查询",
      autoGroups: ["qm"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["qm"]),
      allowedTables: DEFAULT_ROLE_TABLES.quality_manager,
      requireVoucherTypeFilter: true,
    },
    hr_manager: {
      description: "人事主管：考勤/工资相关查询",
      autoGroups: ["timer", "wage", "emp"],
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, ["timer", "wage", "emp"]),
      allowedTables: DEFAULT_ROLE_TABLES.hr_manager,
      requireVoucherTypeFilter: true,
    },
    admin_readonly: {
      description: "系统管理员：只读全量查询",
      autoGroups: CONTROLLED_GROUPS,
      allowedVoucherTypes: buildVoucherTypesByGroups(forms, CONTROLLED_GROUPS),
      allowedTables: DEFAULT_ROLE_TABLES.admin_readonly,
      requireVoucherTypeFilter: false,
    },
  };
}

function buildUsers(wecomUsers) {
  const users = {};
  for (const user of wecomUsers) {
    const userId = normalizeUserId(user.userId);
    if (!userId) {
      continue;
    }
    users[userId] = {
      displayName: user.displayName || "",
      roles: [],
      status: "active",
      note: "",
      updatedAt: nowIso(),
    };
  }
  return users;
}

function mergeUsers(policy, wecomUsers) {
  policy.users = policy.users || {};
  let added = 0;
  for (const user of wecomUsers) {
    const userId = normalizeUserId(user.userId);
    if (!userId) {
      continue;
    }
    const existing = policy.users[userId];
    if (!existing) {
      policy.users[userId] = {
        displayName: user.displayName || "",
        roles: [],
        status: "active",
        note: "",
        updatedAt: nowIso(),
      };
      added += 1;
      continue;
    }
    if (!existing.displayName && user.displayName) {
      existing.displayName = user.displayName;
      existing.updatedAt = nowIso();
    }
  }
  return added;
}

function refreshAutoRoles(policy) {
  for (const roleId of Object.keys(policy.roles || {})) {
    const role = policy.roles[roleId];
    if (!Array.isArray(role.autoGroups) || role.autoGroups.length === 0) {
      continue;
    }
    role.allowedVoucherTypes = buildVoucherTypesByGroups(policy.forms, role.autoGroups);
  }
}

function printRoleList(policy) {
  const roles = policy.roles || {};
  const keys = Object.keys(roles).sort();
  console.log(`roles: ${keys.length}`);
  for (const roleId of keys) {
    const role = roles[roleId];
    const groups = Array.isArray(role.autoGroups) ? role.autoGroups.join(",") : "-";
    const vouchers = Array.isArray(role.allowedVoucherTypes) ? role.allowedVoucherTypes.length : 0;
    console.log(
      `${roleId} | groups=${groups} | vouchers=${vouchers} | tables=${role.allowedTables.join(",")}`,
    );
  }
}

function printUserList(policy) {
  const users = policy.users || {};
  const ids = Object.keys(users).sort();
  console.log(`users: ${ids.length}`);
  for (const id of ids) {
    const user = users[id];
    const name = user.displayName || "-";
    const roles = (user.roles || []).join(",") || "-";
    console.log(`${id} | ${name} | roles=${roles} | status=${user.status || "active"}`);
  }
}

function printForms(policy, groupFilter, activeOnly) {
  const forms = (policy.forms || [])
    .filter((item) => (!groupFilter ? true : item.voucherGroup === groupFilter))
    .filter((item) => (!activeOnly ? true : item.stopFlag !== "Y"));
  console.log(`forms: ${forms.length}`);
  for (const item of forms) {
    console.log(
      `${item.voucherGroup} | ${item.voucherType} | ${item.voucherName} | stop=${item.stopFlag} | used=${item.usedCount} | last=${item.lastDate || "-"}`,
    );
  }
}

function commandListAdmins() {
  const policy = loadPolicy();
  const admins = resolveAclAdmins(policy);
  console.log(`aclAdmins: ${admins.length}`);
  for (const adminId of admins) {
    const user = policy.users?.[adminId] || {};
    const roles = Array.isArray(user.roles) ? user.roles.join(",") : "-";
    console.log(`${adminId} | ${user.displayName || "-"} | roles=${roles || "-"}`);
  }
}

async function commandInit(force, operatorUserId, mutationSecret) {
  if (!force && fs.existsSync(POLICY_PATH)) {
    throw new Error(`Policy already exists: ${POLICY_PATH}. Use --force to overwrite.`);
  }
  const normalizedOperator = normalizeUserId(operatorUserId);
  if (!normalizedOperator) {
    throw new Error('Command "init" requires --operator-wecom-user-id <adminUserId>.');
  }
  const initialSecret = String(mutationSecret || "").trim();
  if (!initialSecret) {
    throw new Error('Command "init" requires --mutation-secret <secret>.');
  }
  validateMutationSecretStrength(initialSecret);

  const forms = await fetchFormsFromDb();
  const users = await fetchWecomUsersFromDb();
  const policy = {
    version: 1,
    updatedAt: nowIso(),
    source: {
      dbServer: DB_CONFIG.server,
      dbName: DB_CONFIG.database,
    },
    forms,
    roles: buildDefaultRoles(forms),
    users: buildUsers(users),
    aclAdmins: [normalizedOperator],
    aclMutationSecretHash: hashMutationSecret(initialSecret),
  };
  const bootstrapUser = ensureUserRecord(policy, normalizedOperator);
  const bootstrapRoles = new Set(bootstrapUser.roles || []);
  bootstrapRoles.add("admin_readonly");
  bootstrapUser.roles = [...bootstrapRoles].sort();
  bootstrapUser.updatedAt = nowIso();
  savePolicy(policy);
  console.log(`initialized policy: ${POLICY_PATH}`);
  console.log(
    `forms=${forms.length}, users=${Object.keys(policy.users).length}, roles=${Object.keys(policy.roles).length}`,
  );
  console.log(`aclAdmins=${policy.aclAdmins.join(",")}`);
  console.log("mutationSecret=configured");
}

async function commandSyncForms() {
  const policy = loadPolicy();
  const forms = await fetchFormsFromDb();
  policy.forms = forms;
  refreshAutoRoles(policy);
  savePolicy(policy);
  console.log(`forms synced: ${forms.length}`);
}

async function commandSyncUsers() {
  const policy = loadPolicy();
  const users = await fetchWecomUsersFromDb();
  const added = mergeUsers(policy, users);
  savePolicy(policy);
  console.log(`users synced: total=${Object.keys(policy.users || {}).length}, added=${added}`);
}

function commandAssign(userId, roleId, displayName) {
  const policy = loadPolicy();
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    throw new Error("Invalid user id.");
  }
  if (!policy.roles?.[roleId]) {
    throw new Error(`Unknown role: ${roleId}`);
  }
  policy.users = policy.users || {};
  if (!policy.users[normalizedUserId]) {
    policy.users[normalizedUserId] = {
      displayName: displayName || "",
      roles: [],
      status: "active",
      note: "",
      updatedAt: nowIso(),
    };
  }
  if (displayName) {
    policy.users[normalizedUserId].displayName = displayName;
  }
  const roles = new Set(policy.users[normalizedUserId].roles || []);
  roles.add(roleId);
  policy.users[normalizedUserId].roles = [...roles].sort();
  policy.users[normalizedUserId].updatedAt = nowIso();
  savePolicy(policy);
  console.log(`assigned: ${normalizedUserId} -> ${policy.users[normalizedUserId].roles.join(",")}`);
}

function commandUnassign(userId, roleId) {
  const policy = loadPolicy();
  const normalizedUserId = normalizeUserId(userId);
  const user = policy.users?.[normalizedUserId];
  if (!user) {
    throw new Error(`Unknown user: ${normalizedUserId}`);
  }
  user.roles = (user.roles || []).filter((item) => item !== roleId);
  user.updatedAt = nowIso();
  savePolicy(policy);
  console.log(`unassigned: ${normalizedUserId} -> ${user.roles.join(",") || "-"}`);
}

function commandSetMutationSecret(currentPolicy, mutationSecret, newMutationSecret) {
  const policy = currentPolicy || loadPolicy();
  const nextSecret = String(newMutationSecret || "").trim();
  if (!nextSecret) {
    throw new Error('Command "set-mutation-secret" requires --new-mutation-secret <newSecret>.');
  }
  validateMutationSecretStrength(nextSecret);

  const configuredHash = normalizeSecretHash(policy.aclMutationSecretHash);
  if (configuredHash) {
    const providedCurrent = String(mutationSecret || "").trim();
    if (!providedCurrent) {
      throw new Error(
        'Command "set-mutation-secret" requires --mutation-secret <currentSecret> when a mutation secret is already configured.',
      );
    }
    if (hashMutationSecret(providedCurrent) !== configuredHash) {
      throw new Error("Invalid mutation secret.");
    }
  }

  const nextHash = hashMutationSecret(nextSecret);
  if (configuredHash && configuredHash === nextHash) {
    throw new Error("New mutation secret must be different from current mutation secret.");
  }

  policy.aclMutationSecretHash = nextHash;
  savePolicy(policy);
  console.log(configuredHash ? "mutation secret rotated." : "mutation secret initialized.");
}

function commandShow(userId) {
  const policy = loadPolicy();
  const normalizedUserId = normalizeUserId(userId);
  const user = policy.users?.[normalizedUserId];
  if (!user) {
    throw new Error(`Unknown user: ${normalizedUserId}`);
  }
  const roleDetails = (user.roles || [])
    .map((roleId) => ({
      roleId,
      ...policy.roles[roleId],
    }))
    .filter((item) => item && item.roleId);
  console.log(
    JSON.stringify(
      {
        userId: normalizedUserId,
        displayName: user.displayName || "",
        status: user.status || "active",
        roles: roleDetails,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const operatorUserId = getOption(args, "--operator-wecom-user-id");
  const mutationSecret = getOption(args, "--mutation-secret");
  const newMutationSecret = getOption(args, "--new-mutation-secret");

  if (!command || command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }

  try {
    if (command === "init") {
      const force = getFlag(args, "--force");
      if (fs.existsSync(POLICY_PATH)) {
        const existingPolicy = loadPolicy();
        requireAclAdminForMutation(existingPolicy, command, operatorUserId);
        requireMutationSecretForCommand(existingPolicy, command, mutationSecret);
      }
      await commandInit(force, operatorUserId, mutationSecret);
      return;
    }
    if (command === "set-mutation-secret") {
      const policy = loadPolicy();
      requireAclAdminForMutation(policy, command, operatorUserId);
      commandSetMutationSecret(policy, mutationSecret, newMutationSecret);
      return;
    }
    if (MUTATING_COMMANDS.has(command)) {
      const policy = loadPolicy();
      requireAclAdminForMutation(policy, command, operatorUserId);
      requireMutationSecretForCommand(policy, command, mutationSecret);
    }
    if (command === "sync-forms") {
      await commandSyncForms();
      return;
    }
    if (command === "sync-users") {
      await commandSyncUsers();
      return;
    }
    if (command === "list-roles") {
      printRoleList(loadPolicy());
      return;
    }
    if (command === "list-users") {
      printUserList(loadPolicy());
      return;
    }
    if (command === "list-admins") {
      commandListAdmins();
      return;
    }
    if (command === "list-forms") {
      const group = getOption(args, "--group");
      const activeOnly = getFlag(args, "--active-only");
      printForms(loadPolicy(), group, activeOnly);
      return;
    }
    if (command === "assign") {
      const userId = args[1];
      const roleId = args[2];
      const name = getOption(args, "--name");
      if (!userId || !roleId) {
        throw new Error("Usage: assign <wecomUserId> <roleId> [--name <displayName>]");
      }
      commandAssign(userId, roleId, name);
      return;
    }
    if (command === "unassign") {
      const userId = args[1];
      const roleId = args[2];
      if (!userId || !roleId) {
        throw new Error("Usage: unassign <wecomUserId> <roleId>");
      }
      commandUnassign(userId, roleId);
      return;
    }
    if (command === "show") {
      const userId = args[1];
      if (!userId) {
        throw new Error("Usage: show <wecomUserId>");
      }
      commandShow(userId);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
