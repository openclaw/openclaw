#!/usr/bin/env node
/**
 * ERP ACL Web Console Server
 *
 * Local-only admin UI for:
 * - Syncing ERP forms/users
 * - Assigning WeCom userId roles
 * - Reviewing role -> voucher/table permissions
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const POLICY_PATH = path.join(ROOT, "policy", "acl-policy.json");
const ACL_CONSOLE = path.join(__dirname, "acl-console.cjs");
const WRAPPER_DIR = path.join(__dirname, "agent-wrappers");
const SECURE_QUERY_SCRIPT = path.join(__dirname, "secure-query.cjs");

const args = process.argv.slice(2);
const portArgIndex = args.indexOf("--port");
const hostArgIndex = args.indexOf("--host");
const tokenArgIndex = args.indexOf("--token");
const operatorArgIndex = args.indexOf("--operator-wecom-user-id");
const mutationSecretArgIndex = args.indexOf("--mutation-secret");

const PORT = Number(
  portArgIndex >= 0 ? args[portArgIndex + 1] : process.env.ERP_ACL_WEB_PORT || 18990,
);
const HOST = hostArgIndex >= 0 ? args[hostArgIndex + 1] : "127.0.0.1";
const ADMIN_TOKEN =
  tokenArgIndex >= 0 ? args[tokenArgIndex + 1] : process.env.ERP_ACL_WEB_TOKEN || "";
const ADMIN_OPERATOR_USER_ID =
  operatorArgIndex >= 0 ? args[operatorArgIndex + 1] : process.env.ERP_ACL_OPERATOR_USER_ID || "";
const ADMIN_MUTATION_SECRET =
  mutationSecretArgIndex >= 0
    ? String(args[mutationSecretArgIndex + 1] || "")
    : String(process.env.ERP_ACL_MUTATION_SECRET || "");

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Payload too large."));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function requireToken(req) {
  if (!ADMIN_TOKEN) {
    return true;
  }
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ") && auth.slice(7) === ADMIN_TOKEN) {
    return true;
  }
  return false;
}

function normalizeUserId(userId) {
  return String(userId || "")
    .trim()
    .toLowerCase();
}

function resolveOperatorUserId(req, body) {
  const headerOperator = normalizeUserId(req.headers["x-wecom-user-id"]);
  const bodyOperator =
    body && typeof body.operatorUserId === "string" ? normalizeUserId(body.operatorUserId) : "";
  const defaultOperator = normalizeUserId(ADMIN_OPERATOR_USER_ID);
  return bodyOperator || headerOperator || defaultOperator;
}

function resolveMutationSecret(req, body) {
  const headerSecret = String(req.headers["x-acl-mutation-secret"] || "").trim();
  const bodySecret =
    body && typeof body.mutationSecret === "string" ? String(body.mutationSecret).trim() : "";
  const defaultSecret = String(ADMIN_MUTATION_SECRET || "").trim();
  return bodySecret || headerSecret || defaultSecret;
}

function runAclConsole(argv, options = {}) {
  const fullArgv = [...argv];
  if (options.mutating) {
    const operatorUserId = normalizeUserId(options.operatorUserId);
    if (!operatorUserId) {
      throw new Error(
        "Missing operator user id. Set --operator-wecom-user-id on server startup, provide x-wecom-user-id header, or body.operatorUserId.",
      );
    }
    fullArgv.push("--operator-wecom-user-id", operatorUserId);

    const mutationSecret = String(options.mutationSecret || "").trim();
    if (!mutationSecret && !options.allowEmptyMutationSecret) {
      throw new Error(
        "Missing mutation secret. Set --mutation-secret on server startup, provide x-acl-mutation-secret header, or body.mutationSecret.",
      );
    }
    if (mutationSecret) {
      fullArgv.push("--mutation-secret", mutationSecret);
    }
  }

  const result = spawnSync(process.execPath, [ACL_CONSOLE, ...fullArgv], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const errText = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(errText || `acl-console failed: ${result.status}`);
  }
  return {
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function normalizeSecretHash(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(raw) ? raw : "";
}

function assertMutationSecret(secret) {
  const policy = loadPolicy();
  if (!policy) {
    throw new Error("ACL policy is not initialized. Initialize ACL policy first.");
  }
  const configuredHash = normalizeSecretHash(policy.aclMutationSecretHash);
  if (!configuredHash) {
    throw new Error("ACL mutation secret is not configured yet.");
  }
  const providedSecret = String(secret || "").trim();
  if (!providedSecret) {
    throw new Error("Mutation secret is required for this operation.");
  }
  const providedHash = crypto.createHash("sha256").update(providedSecret, "utf8").digest("hex");
  if (providedHash !== configuredHash) {
    throw new Error("Invalid mutation secret.");
  }
}

function normalizeAgentId(agentId) {
  return String(agentId || "").trim();
}

function sanitizeShellArg(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeSlug(value) {
  return (
    normalizeUserId(value)
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "wecom-user"
  );
}

function inferWecomDmAgentId(wecomUserId) {
  const normalized = normalizeUserId(wecomUserId);
  if (!normalized) {
    return "";
  }
  return `wecom-dm-${normalized}`;
}

function wrapperScriptPathForUser(wecomUserId) {
  return path.join(WRAPPER_DIR, `${sanitizeSlug(wecomUserId)}-secure-query.sh`);
}

function wrapperScriptContent(wecomUserId) {
  const quotedNode = sanitizeShellArg(process.execPath);
  const quotedSecureQuery = sanitizeShellArg(SECURE_QUERY_SCRIPT);
  const quotedUserId = sanitizeShellArg(wecomUserId);
  return `#!/usr/bin/env bash
set -euo pipefail

cmd="\${1:-}"
case "$cmd" in
  supplier|permissions|sql)
    ;;
  *)
    echo "Only 'supplier', 'sql' and 'permissions' commands are allowed." >&2
    exit 1
    ;;
esac

set +e
output="$(${quotedNode} ${quotedSecureQuery} --wecom-user-id ${quotedUserId} "$@" 2>&1)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '%s\\n' "$output"
  exit 0
fi

if printf '%s' "$output" | grep -Eiq "(当前没有权限。|has no ACL entry\\.|has no roles\\.|is not allowed for this user\\.|does not have procurement voucher permissions\\.|must include explicit voucher_type/ref_voucher_type filters\\.)"; then
  echo "当前没有权限。"
  exit 1
fi

printf '%s\\n' "$output" >&2
exit "$status"
`;
}

function ensureWrapperScript(wecomUserId) {
  const normalizedUser = normalizeUserId(wecomUserId);
  if (!normalizedUser) {
    throw new Error("wecomUserId is required.");
  }
  fs.mkdirSync(WRAPPER_DIR, { recursive: true });
  const scriptPath = wrapperScriptPathForUser(normalizedUser);
  const content = wrapperScriptContent(normalizedUser);
  const exists = fs.existsSync(scriptPath);
  const previous = exists ? fs.readFileSync(scriptPath, "utf8") : "";
  if (previous !== content) {
    fs.writeFileSync(scriptPath, content, "utf8");
  }
  fs.chmodSync(scriptPath, 0o755);
  return {
    scriptPath,
    created: !exists,
    updated: exists && previous !== content,
  };
}

function commandFailureText(bin, argv, result) {
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (output) {
    return output;
  }
  return `${[bin, ...argv].join(" ")} failed with exit code ${String(result.status)}`;
}

function runOpenclaw(argv, options = {}) {
  const candidates = [];
  if (process.env.OPENCLAW_BIN) {
    candidates.push(String(process.env.OPENCLAW_BIN));
  }
  candidates.push(path.join(path.dirname(process.execPath), "openclaw"));
  candidates.push("openclaw");

  const uniqueCandidates = [...new Set(candidates)];
  for (const bin of uniqueCandidates) {
    const result = spawnSync(bin, argv, { encoding: "utf8" });
    if (result.error) {
      if (result.error.code === "ENOENT") {
        continue;
      }
      throw new Error(`${[bin, ...argv].join(" ")} failed: ${result.error.message}`);
    }

    if (options.allowFailure) {
      return result;
    }

    if (result.status !== 0) {
      throw new Error(commandFailureText(bin, argv, result));
    }
    return result;
  }

  throw new Error("openclaw CLI was not found. Set OPENCLAW_BIN to your openclaw executable path.");
}

function parseJsonOutput(raw, label) {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error(`Empty JSON output: ${label}`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.search(/[\[{]/);
    if (start >= 0) {
      const sliced = text.slice(start);
      return JSON.parse(sliced);
    }
    throw new Error(`Invalid JSON output: ${label}`);
  }
}

function getConfiguredAgents() {
  const result = runOpenclaw(["config", "get", "agents.list", "--strict-json"]);
  const list = parseJsonOutput(result.stdout, "agents.list");
  if (!Array.isArray(list)) {
    throw new Error("Invalid agents.list format.");
  }
  return list.map((item, index) => ({
    index,
    id: normalizeAgentId(item?.id),
    modelPrimary: String(item?.model?.primary || ""),
    tools: item?.tools && typeof item.tools === "object" ? item.tools : {},
  }));
}

function resolveAgentForHardening(agents, requestedAgentId, wecomUserId) {
  const preferredId = normalizeAgentId(requestedAgentId) || inferWecomDmAgentId(wecomUserId);
  if (!preferredId) {
    throw new Error("agentId or wecomUserId is required.");
  }
  const target = agents.find((item) => item.id === preferredId);
  if (!target) {
    throw new Error(`Agent "${preferredId}" not found in agents.list.`);
  }
  return target;
}

function sortUniqueStrings(values) {
  return [...new Set(values.filter((item) => String(item || "").trim().length > 0))].sort();
}

function buildMinimalAgentTools(existingTools) {
  const current = existingTools && typeof existingTools === "object" ? existingTools : {};
  const existingDeny = Array.isArray(current.deny) ? current.deny.map((item) => String(item)) : [];
  const existingAllow = Array.isArray(current.allow)
    ? current.allow.map((item) => String(item))
    : [];
  const deny = sortUniqueStrings([
    ...existingDeny.filter((item) => item !== "exec"),
    "process",
    "write",
    "edit",
    "apply_patch",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "gateway",
    "agents_list",
  ]);

  const next = {
    ...current,
    deny,
    exec: {
      host: "gateway",
      security: "allowlist",
      ask: "off",
    },
  };

  if (existingAllow.length > 0) {
    next.allow = sortUniqueStrings([...existingAllow, "exec"]);
  }

  return next;
}

function allowlistContainsPath(approvalText, agentId, scriptPath) {
  const normalizedScriptPath = scriptPath.replace(/^\/Users\/[^/]+/, "~");
  return (
    approvalText.includes(agentId) &&
    (approvalText.includes(scriptPath) || approvalText.includes(normalizedScriptPath))
  );
}

function ensureAgentAllowlist(agentId, scriptPath) {
  const check = runOpenclaw(["approvals", "get"], { allowFailure: true });
  const checkText = [check.stdout, check.stderr].filter(Boolean).join("\n");
  if (check.status === 0 && allowlistContainsPath(checkText, agentId, scriptPath)) {
    return { added: false };
  }

  const add = runOpenclaw(["approvals", "allowlist", "add", "--agent", agentId, scriptPath], {
    allowFailure: true,
  });
  if (add.status === 0) {
    return { added: true };
  }
  const addText = [add.stdout, add.stderr].filter(Boolean).join("\n");
  if (/already|exists|duplicate/i.test(addText)) {
    return { added: false };
  }
  throw new Error(addText.trim() || "Failed to add exec allowlist entry.");
}

function applyAgentHardening(params) {
  const wecomUserId = normalizeUserId(params.wecomUserId);
  if (!wecomUserId) {
    throw new Error("wecomUserId is required.");
  }

  const agents = getConfiguredAgents();
  const target = resolveAgentForHardening(agents, params.agentId, wecomUserId);
  const wrapper = ensureWrapperScript(wecomUserId);

  const tools = buildMinimalAgentTools(target.tools);
  runOpenclaw([
    "config",
    "set",
    `agents.list[${target.index}].tools`,
    JSON.stringify(tools),
    "--strict-json",
  ]);

  let modelChanged = false;
  if (params.forceOpenaiCodexModel) {
    runOpenclaw([
      "config",
      "set",
      `agents.list[${target.index}].model.primary`,
      "openai-codex/gpt-5.3-codex",
    ]);
    modelChanged = true;
  }

  const allowlist = ensureAgentAllowlist(target.id, wrapper.scriptPath);

  let restarted = false;
  if (params.restartGateway) {
    runOpenclaw(["gateway", "restart"]);
    restarted = true;
  }

  return {
    agentId: target.id,
    agentIndex: target.index,
    wecomUserId,
    wrapperScriptPath: wrapper.scriptPath,
    wrapperCreated: wrapper.created,
    wrapperUpdated: wrapper.updated,
    allowlistAdded: allowlist.added,
    modelChanged,
    gatewayRestarted: restarted,
    sampleCommand: `${wrapper.scriptPath} supplier B0069 --json`,
  };
}

function loadPolicy() {
  if (!fs.existsSync(POLICY_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(POLICY_PATH, "utf8");
  return JSON.parse(raw);
}

function policySummary(policy) {
  if (!policy) {
    return {
      exists: false,
      policyPath: POLICY_PATH,
      forms: [],
      roles: [],
      users: [],
      stats: {},
      security: {
        mutationSecretConfigured: false,
      },
    };
  }

  const forms = (policy.forms || []).map((item) => ({
    voucherGroup: item.voucherGroup,
    voucherType: item.voucherType,
    voucherName: item.voucherName,
    stopFlag: item.stopFlag,
    usedCount: item.usedCount,
    lastDate: item.lastDate,
  }));

  const roleMap = policy.roles || {};
  const roles = Object.keys(roleMap)
    .sort()
    .map((roleId) => {
      const role = roleMap[roleId] || {};
      return {
        roleId,
        description: role.description || "",
        autoGroups: role.autoGroups || [],
        allowedVoucherTypes: role.allowedVoucherTypes || [],
        allowedTables: role.allowedTables || [],
        requireVoucherTypeFilter: Boolean(role.requireVoucherTypeFilter),
      };
    });

  const userMap = policy.users || {};
  const users = Object.keys(userMap)
    .sort()
    .map((userId) => {
      const user = userMap[userId] || {};
      return {
        userId,
        displayName: user.displayName || "",
        status: user.status || "active",
        roles: user.roles || [],
        note: user.note || "",
        updatedAt: user.updatedAt || null,
      };
    });

  const formsByGroup = {};
  for (const form of forms) {
    const group = form.voucherGroup || "unknown";
    if (!formsByGroup[group]) {
      formsByGroup[group] = { total: 0, active: 0, usedCount: 0 };
    }
    formsByGroup[group].total += 1;
    if (form.stopFlag !== "Y") {
      formsByGroup[group].active += 1;
      formsByGroup[group].usedCount += Number(form.usedCount || 0);
    }
  }

  return {
    exists: true,
    policyPath: POLICY_PATH,
    updatedAt: policy.updatedAt || null,
    source: policy.source || {},
    forms,
    roles,
    users,
    stats: {
      formCount: forms.length,
      roleCount: roles.length,
      userCount: users.length,
      formsByGroup,
    },
    security: {
      mutationSecretConfigured: /^[a-f0-9]{64}$/.test(
        String(policy.aclMutationSecretHash || "")
          .trim()
          .toLowerCase(),
      ),
    },
  };
}

function sendStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/acl-console.html" : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(WEB_DIR, filePath);

  if (!abs.startsWith(WEB_DIR)) {
    json(res, 403, { error: "Forbidden." });
    return;
  }

  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    json(res, 404, { error: "Not found." });
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";

  const content = fs.readFileSync(abs);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  res.end(content);
}

async function handleApi(req, res, pathname) {
  if (!requireToken(req)) {
    json(res, 401, { error: "Unauthorized." });
    return;
  }

  try {
    if (req.method === "GET" && pathname === "/api/policy") {
      json(res, 200, { ok: true, data: policySummary(loadPolicy()) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/agents") {
      const agents = getConfiguredAgents().map((item) => ({
        id: item.id,
        index: item.index,
        modelPrimary: item.modelPrimary || "",
      }));
      json(res, 200, { ok: true, data: { agents } });
      return;
    }

    if (req.method === "POST" && pathname === "/api/init") {
      const body = await readJsonBody(req);
      const force = Boolean(body.force);
      const operatorUserId = resolveOperatorUserId(req, body);
      const mutationSecret = resolveMutationSecret(req, body);
      const out = runAclConsole(["init", ...(force ? ["--force"] : [])], {
        mutating: true,
        operatorUserId,
        mutationSecret,
      });
      json(res, 200, { ok: true, message: out.stdout || "initialized" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sync/forms") {
      const body = await readJsonBody(req);
      const operatorUserId = resolveOperatorUserId(req, body);
      const mutationSecret = resolveMutationSecret(req, body);
      const out = runAclConsole(["sync-forms"], {
        mutating: true,
        operatorUserId,
        mutationSecret,
      });
      json(res, 200, { ok: true, message: out.stdout || "forms synced" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sync/users") {
      const body = await readJsonBody(req);
      const operatorUserId = resolveOperatorUserId(req, body);
      const mutationSecret = resolveMutationSecret(req, body);
      const out = runAclConsole(["sync-users"], {
        mutating: true,
        operatorUserId,
        mutationSecret,
      });
      json(res, 200, { ok: true, message: out.stdout || "users synced" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/assign") {
      const body = await readJsonBody(req);
      const operatorUserId = resolveOperatorUserId(req, body);
      const mutationSecret = resolveMutationSecret(req, body);
      const userId = String(body.userId || "").trim();
      const roleId = String(body.roleId || "").trim();
      const displayName = String(body.displayName || "").trim();
      if (!userId || !roleId) {
        json(res, 400, { ok: false, error: "userId and roleId are required." });
        return;
      }
      const out = runAclConsole(
        ["assign", userId, roleId, ...(displayName ? ["--name", displayName] : [])],
        {
          mutating: true,
          operatorUserId,
          mutationSecret,
        },
      );
      json(res, 200, { ok: true, message: out.stdout || "assigned" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/unassign") {
      const body = await readJsonBody(req);
      const operatorUserId = resolveOperatorUserId(req, body);
      const mutationSecret = resolveMutationSecret(req, body);
      const userId = String(body.userId || "").trim();
      const roleId = String(body.roleId || "").trim();
      if (!userId || !roleId) {
        json(res, 400, { ok: false, error: "userId and roleId are required." });
        return;
      }
      const out = runAclConsole(["unassign", userId, roleId], {
        mutating: true,
        operatorUserId,
        mutationSecret,
      });
      json(res, 200, { ok: true, message: out.stdout || "unassigned" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/mutation-secret") {
      const body = await readJsonBody(req);
      const operatorUserId = resolveOperatorUserId(req, body);
      const currentMutationSecret =
        typeof body.currentMutationSecret === "string"
          ? String(body.currentMutationSecret).trim()
          : resolveMutationSecret(req, body);
      const newMutationSecret = String(body.newMutationSecret || "").trim();
      if (!newMutationSecret) {
        json(res, 400, { ok: false, error: "newMutationSecret is required." });
        return;
      }

      const out = runAclConsole(
        ["set-mutation-secret", "--new-mutation-secret", newMutationSecret],
        {
          mutating: true,
          operatorUserId,
          mutationSecret: currentMutationSecret,
          allowEmptyMutationSecret: true,
        },
      );
      json(res, 200, { ok: true, message: out.stdout || "mutation secret updated" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/agent-hardening/apply") {
      const body = await readJsonBody(req);
      const mutationSecret = resolveMutationSecret(req, body);
      assertMutationSecret(mutationSecret);

      const agentId = normalizeAgentId(body.agentId);
      const wecomUserId = normalizeUserId(body.wecomUserId);
      if (!wecomUserId) {
        json(res, 400, { ok: false, error: "wecomUserId is required." });
        return;
      }

      const result = applyAgentHardening({
        agentId,
        wecomUserId,
        forceOpenaiCodexModel: body.forceOpenaiCodexModel !== false,
        restartGateway: body.restartGateway !== false,
      });
      json(res, 200, { ok: true, data: result });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/user/")) {
      const userId = decodeURIComponent(pathname.replace("/api/user/", ""));
      const out = runAclConsole(["show", userId]);
      const parsed = JSON.parse(out.stdout || "{}");
      json(res, 200, { ok: true, data: parsed });
      return;
    }

    json(res, 404, { ok: false, error: "Unknown API endpoint." });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message || "Internal error." });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, pathname);
    return;
  }

  sendStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`ERP ACL Web Console listening: http://${HOST}:${PORT}/`);
  console.log(`Policy file: ${POLICY_PATH}`);
  if (ADMIN_TOKEN) {
    console.log("Auth: enabled (Bearer token required)");
  } else {
    console.log("Auth: disabled (local loopback recommended)");
  }
  if (ADMIN_OPERATOR_USER_ID) {
    console.log(`Default operator: ${normalizeUserId(ADMIN_OPERATOR_USER_ID)}`);
  } else {
    console.log(
      "Default operator: not set (set --operator-wecom-user-id or ERP_ACL_OPERATOR_USER_ID)",
    );
  }
  if (String(ADMIN_MUTATION_SECRET || "").trim()) {
    console.log("Default mutation secret: configured");
  } else {
    console.log(
      "Default mutation secret: not set (set --mutation-secret or ERP_ACL_MUTATION_SECRET)",
    );
  }
});
