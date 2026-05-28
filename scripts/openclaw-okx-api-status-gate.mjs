import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-api-status-gate-latest.json",
);
const DEFAULT_ROTATION_RECEIPT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-credential-rotation-receipt.json",
);
const DEFAULT_SYMBOL = "BTC-USDT";
const OPENCLAW_OKX_STATUS_SKILL_PATH = path.join(
  repoRoot,
  "skills",
  "openclaw-okx-cex-status",
  "SKILL.md",
);
const LIVE_PROFILE_CANDIDATES = ["main", "live"];
const DEMO_PROFILE_CANDIDATES = ["demo"];
const CHAT_SUPPLIED_SECRET_POLICY = "chat_supplied_secret_must_rotate";
const WITHDRAW_PERMISSION_POLICY = "withdraw_permission_blocked";
const BLANK_IP_WRITE_PERMISSION_POLICY = "blank_ip_with_trade_or_withdraw_blocked";

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOkxCliEntry() {
  const override = process.env.OPENCLAW_OKX_CLI_ENTRY;
  if (override && (await pathExists(override))) {
    return override;
  }
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "@okx_ai",
        "okx-trade-cli",
        "dist",
        "index.js",
      ),
    );
  }
  if (process.env.PREFIX) {
    candidates.push(
      path.join(process.env.PREFIX, "node_modules", "@okx_ai", "okx-trade-cli", "dist", "index.js"),
    );
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sanitizeOutput(value) {
  return String(value || "")
    .replace(/(api[_ -]?key\s+)(\S+)/giu, "$1<redacted>")
    .replace(/(secret[_ -]?key\s+)(\S+)/giu, "$1<redacted>")
    .replace(/(passphrase\s+)(\S+)/giu, "$1<redacted>")
    .trim();
}

function runOkx(cliEntry, args) {
  if (!cliEntry) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: "okx_cli_not_found",
    };
  }
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: sanitizeOutput(result.stdout),
    stderr: sanitizeOutput(result.stderr),
    error: result.error?.message || "",
  };
}

function parseVersion(output) {
  const firstLine = output.split(/\r?\n/u).find((line) => line.trim()) || "";
  const match = firstLine.match(/\b(\d+\.\d+\.\d+)\b/u);
  return match?.[1] || "";
}

function parseProfiles(configOutput) {
  const profiles = [];
  let defaultProfile = "";
  for (const line of configOutput.split(/\r?\n/u)) {
    const defaultMatch = line.match(/^\s*default_profile:\s*(\S+)/u);
    if (defaultMatch) {
      defaultProfile = defaultMatch[1];
      continue;
    }
    const profileMatch = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (profileMatch) {
      profiles.push(profileMatch[1]);
    }
  }
  return { defaultProfile, profiles };
}

async function readLocalConfigAudit() {
  const configPath =
    process.env.OPENCLAW_OKX_CONFIG_PATH ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".okx", "config.toml") : "");
  if (!configPath || !(await pathExists(configPath))) {
    return {
      path: "",
      exists: false,
      profileFields: {},
    };
  }
  const raw = await fs.readFile(configPath, "utf8");
  const profileFields = {};
  let currentProfile = "";
  for (const line of raw.split(/\r?\n/u)) {
    const section = line.match(/^\s*\[(?:profiles\.)?([^\]]+)\]\s*$/u);
    if (section) {
      currentProfile = section[1];
      profileFields[currentProfile] ??= {
        apiKeyPresent: false,
        secretKeyPresent: false,
        passphrasePresent: false,
      };
      continue;
    }
    if (!currentProfile) {
      continue;
    }
    if (/^\s*api_key\s*=/u.test(line)) {
      profileFields[currentProfile].apiKeyPresent = true;
    } else if (/^\s*secret_key\s*=/u.test(line)) {
      profileFields[currentProfile].secretKeyPresent = true;
    } else if (/^\s*passphrase\s*=/u.test(line)) {
      profileFields[currentProfile].passphrasePresent = true;
    }
  }
  return {
    path: configPath,
    exists: true,
    profileFields,
  };
}

function normalizePermissionSet(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((permission) =>
          String(permission || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
}

async function readCredentialRotationReceipt() {
  const receiptPath = path.resolve(
    process.env.OPENCLAW_OKX_ROTATION_RECEIPT_PATH || DEFAULT_ROTATION_RECEIPT_PATH,
  );
  if (!(await pathExists(receiptPath))) {
    return {
      path: receiptPath,
      pathHint: path.relative(repoRoot, receiptPath).split(path.sep).join("/"),
      exists: false,
      code: "rotation_receipt_missing",
      schemaOk: false,
      revokedChatSuppliedKey: false,
      newKeyStoredLocalOnly: false,
      newKeyNeverPastedToChat: false,
      permissionSet: [],
      tradePermission: false,
      withdrawPermission: true,
      ipAllowlistConfigured: false,
    };
  }
  try {
    const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    const permissionSet = normalizePermissionSet(parsed.permissionSet);
    const tradePermission = parsed.tradePermission === true || permissionSet.includes("trade");
    const withdrawPermission =
      parsed.withdrawPermission === true || permissionSet.includes("withdraw");
    const ipAllowlist = Array.isArray(parsed.ipAllowlist)
      ? parsed.ipAllowlist.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    const receipt = {
      path: receiptPath,
      pathHint: path.relative(repoRoot, receiptPath).split(path.sep).join("/"),
      exists: true,
      code: "rotation_receipt_read",
      schemaOk: parsed.schema === "openclaw.okx.credential-rotation-receipt.v1",
      revokedChatSuppliedKey: parsed.revokedChatSuppliedKey === true,
      newKeyStoredLocalOnly: parsed.newKeyStoredLocalOnly === true,
      newKeyNeverPastedToChat: parsed.newKeyNeverPastedToChat === true,
      permissionSet,
      tradePermission,
      withdrawPermission,
      ipAllowlistConfigured: parsed.ipAllowlistConfigured === true || ipAllowlist.length > 0,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
    return {
      ...receipt,
      code:
        receipt.schemaOk &&
        receipt.revokedChatSuppliedKey &&
        receipt.newKeyStoredLocalOnly &&
        receipt.newKeyNeverPastedToChat
          ? "rotation_receipt_ok"
          : "rotation_receipt_incomplete",
    };
  } catch {
    return {
      path: receiptPath,
      pathHint: path.relative(repoRoot, receiptPath).split(path.sep).join("/"),
      exists: true,
      code: "rotation_receipt_invalid_json",
      schemaOk: false,
      revokedChatSuppliedKey: false,
      newKeyStoredLocalOnly: false,
      newKeyNeverPastedToChat: false,
      permissionSet: [],
      tradePermission: false,
      withdrawPermission: true,
      ipAllowlistConfigured: false,
    };
  }
}

function buildCredentialPolicyState(rotationReceipt) {
  const chatPostedKeyRotated =
    rotationReceipt.code === "rotation_receipt_ok" &&
    rotationReceipt.revokedChatSuppliedKey &&
    rotationReceipt.newKeyStoredLocalOnly &&
    rotationReceipt.newKeyNeverPastedToChat;
  const withdrawPermissionAbsent = chatPostedKeyRotated && !rotationReceipt.withdrawPermission;
  const writePermissionPresent =
    rotationReceipt.tradePermission || rotationReceipt.withdrawPermission;
  const ipAllowlistSafe =
    chatPostedKeyRotated && (!writePermissionPresent || rotationReceipt.ipAllowlistConfigured);
  const unresolvedMarkers = [];
  if (!chatPostedKeyRotated) {
    unresolvedMarkers.push(CHAT_SUPPLIED_SECRET_POLICY);
  }
  if (!withdrawPermissionAbsent) {
    unresolvedMarkers.push(WITHDRAW_PERMISSION_POLICY);
  }
  if (!ipAllowlistSafe) {
    unresolvedMarkers.push(BLANK_IP_WRITE_PERMISSION_POLICY);
  }
  return {
    chatPostedKeyRotated,
    withdrawPermissionAbsent,
    ipAllowlistSafe,
    unresolvedMarkers,
  };
}

async function readOpenClawSkillAudit() {
  if (!(await pathExists(OPENCLAW_OKX_STATUS_SKILL_PATH))) {
    return {
      path: "skills/openclaw-okx-cex-status/SKILL.md",
      exists: false,
      readOnlyDeclared: false,
      localConfigOnlyDeclared: false,
      noOrderDeclared: false,
      noCodexGlobalRuntimeDeclared: false,
      commandsDeclared: false,
    };
  }
  const content = await fs.readFile(OPENCLAW_OKX_STATUS_SKILL_PATH, "utf8");
  return {
    path: "skills/openclaw-okx-cex-status/SKILL.md",
    exists: true,
    readOnlyDeclared: /readOnly"?\s*:\s*true/u.test(content) || /read-only/iu.test(content),
    localConfigOnlyDeclared:
      /localConfigOnly"?\s*:\s*true/u.test(content) || /local-only|local config/iu.test(content),
    noOrderDeclared:
      /orderPlacementEnabled"?\s*:\s*false/u.test(content) &&
      /does not place|does not .*orders|order_not_enabled/iu.test(content),
    noCodexGlobalRuntimeDeclared: /usesCodexGlobalSkillAsRuntime"?\s*:\s*false/u.test(content),
    commandsDeclared:
      content.includes("pnpm okx:api-status") && content.includes("pnpm okx:api-status:check"),
  };
}

function parseTicker(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const ticker = Array.isArray(parsed) ? parsed[0] : parsed?.data?.[0];
    if (!ticker || typeof ticker !== "object") {
      return null;
    }
    return {
      instId: String(ticker.instId || ""),
      last: String(ticker.last || ""),
      bidPx: String(ticker.bidPx || ""),
      askPx: String(ticker.askPx || ""),
      ts: String(ticker.ts || ""),
    };
  } catch {
    return null;
  }
}

function profileCode(kind, profileName, result) {
  if (!profileName) {
    return `${kind}_missing`;
  }
  if (result.ok) {
    return `${kind}_ok`;
  }
  const combined = `${result.stdout}\n${result.stderr}\n${result.error}`;
  if (/401|Invalid OK-ACCESS-KEY/u.test(combined)) {
    return `${kind}_401`;
  }
  return `${kind}_blocked`;
}

function selectProfile(profiles, candidates) {
  return candidates.find((candidate) => profiles.includes(candidate)) || "";
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function buildOkxApiStatusGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const symbol = options.symbol || DEFAULT_SYMBOL;
  const cliEntry = await resolveOkxCliEntry();
  const localConfigAudit = await readLocalConfigAudit();
  const rotationReceipt = await readCredentialRotationReceipt();
  const credentialPolicyState = buildCredentialPolicyState(rotationReceipt);
  const openclawSkillAudit = await readOpenClawSkillAudit();
  const versionRun = runOkx(cliEntry, ["--version"]);
  const configRun = runOkx(cliEntry, ["config", "show"]);
  const profileInfo = configRun.ok
    ? parseProfiles(configRun.stdout)
    : { defaultProfile: "", profiles: [] };
  const liveProfile = selectProfile(profileInfo.profiles, LIVE_PROFILE_CANDIDATES);
  const demoProfile = selectProfile(profileInfo.profiles, DEMO_PROFILE_CANDIDATES);
  const quoteRun = runOkx(cliEntry, ["market", "ticker", symbol, "--json"]);
  const quote = parseTicker(quoteRun.stdout);
  const liveRun = liveProfile
    ? runOkx(cliEntry, ["--profile", liveProfile, "account", "config"])
    : null;
  const demoRun = demoProfile
    ? runOkx(cliEntry, ["--profile", demoProfile, "account", "config"])
    : null;
  const liveCode = profileCode("live", liveProfile, liveRun || { ok: false });
  const demoCode = profileCode("demo", demoProfile, demoRun || { ok: false });
  const quoteCode = quoteRun.ok && quote?.last ? "quote_ok" : "quote_blocked";
  const orderCode = "order_not_enabled";
  const policyMarkers = credentialPolicyState.unresolvedMarkers;
  const skillCode =
    openclawSkillAudit.exists &&
    openclawSkillAudit.readOnlyDeclared &&
    openclawSkillAudit.localConfigOnlyDeclared &&
    openclawSkillAudit.noOrderDeclared &&
    openclawSkillAudit.noCodexGlobalRuntimeDeclared &&
    openclawSkillAudit.commandsDeclared
      ? "openclaw_skill_ok"
      : "openclaw_skill_blocked";
  // live_401 在 main profile 使用佔位符時降級為 info（不阻擋 demo-only 模式）
  const liveIsPlaceholder =
    localConfigAudit.exists && localConfigAudit.profileFields?.main && !liveRun?.ok;
  const effectiveLiveCode =
    liveCode === "live_401" && liveIsPlaceholder ? "live_placeholder" : liveCode;
  const authBlockers = [demoCode, quoteCode].filter((code) => !code.endsWith("_ok"));
  if (effectiveLiveCode !== "live_placeholder" && !effectiveLiveCode.endsWith("_ok")) {
    authBlockers.push(effectiveLiveCode);
  }
  const blockers = [
    ...authBlockers,
    ...(skillCode === "openclaw_skill_ok" ? [] : [skillCode]),
    orderCode,
  ];
  const markers = [demoCode, liveCode, quoteCode, skillCode, orderCode, ...policyMarkers];
  const status =
    quoteCode === "quote_ok" && demoCode === "demo_ok"
      ? liveCode === "live_ok"
        ? "read_only_live_and_demo_verified"
        : "read_only_demo_verified_live_blocked"
      : "blocked_or_degraded";

  return {
    schema: "openclaw.okx.api-status-gate.v1",
    generatedAt,
    provider: "okx",
    status,
    language: "zh-TW",
    markers,
    blockers,
    summary_zh_tw: [
      `OKX demo=${demoCode}`,
      `live=${liveCode}`,
      `quote=${quoteCode}`,
      `skill=${skillCode}`,
      "order=order_not_enabled",
      `policy=${policyMarkers.length === 0 ? "credential_policy_ok" : "secret_rotation_required"}`,
    ].join("；"),
    cli: {
      available: Boolean(cliEntry),
      entryResolved: Boolean(cliEntry),
      version: parseVersion(versionRun.stdout),
      versionCheckOk: versionRun.ok,
    },
    config: {
      checked: configRun.ok,
      defaultProfile: profileInfo.defaultProfile,
      configuredProfiles: profileInfo.profiles,
      configMaskedOnly: true,
      localConfigExists: localConfigAudit.exists,
      localConfigPathHint: localConfigAudit.exists ? ".okx/config.toml" : "",
      profileFields: localConfigAudit.profileFields,
    },
    openclawSkill: {
      code: skillCode,
      ...openclawSkillAudit,
    },
    quote: {
      code: quoteCode,
      readOnly: true,
      symbol,
      source: "okx_market_ticker",
      instId: quote?.instId || "",
      last: quote?.last || "",
      bidPx: quote?.bidPx || "",
      askPx: quote?.askPx || "",
      ts: quote?.ts || "",
    },
    agentTradeKit: {
      source: "official_okx_agent_trade_kit",
      mcpCompatible: true,
      cliCompatible: true,
      requiredProfileForAuthenticatedCommands: true,
      demoProfile: "demo",
      liveProfileCandidates: LIVE_PROFILE_CANDIDATES,
      demoModeRule:
        "use --profile demo for simulated trading; do not infer demo from missing live credentials",
      liveModeRule:
        "use --profile live/main only after OpenClaw promotion gates and human approval pass",
      officialDocs: [
        "https://www.okx.com/docs-v5/en/",
        "https://www.okx.com/docs-v5/agent_en/",
        "https://github.com/okx/agent-trade-kit",
      ],
      externalResearchReport:
        "reports/hermes-agent/state/openclaw-auto-trading-external-research-latest.md",
    },
    authentication: {
      demo: {
        profile: demoProfile,
        code: demoCode,
        readOnlyAccountConfigOk: demoRun?.ok === true,
      },
      live: {
        profile: liveProfile,
        code: liveCode,
        readOnlyAccountConfigOk: liveRun?.ok === true,
      },
    },
    safety: {
      orderPlacementEnabled: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      withdrawalEnabled: false,
      submittedOrder: false,
      cancelOrderEnabled: false,
      amendOrderEnabled: false,
      readOnlyCommandsOnly: true,
      credentialEchoed: false,
      acceptsChatProvidedSecrets: false,
      storesSecretsInRepo: false,
      allowsWithdrawPermission: false,
      allowsBlankIpWithWritePermission: false,
    },
    credentialPolicy: {
      passphraseRequired: true,
      localConfigOnly: true,
      chatProvidedCredentialAction: credentialPolicyState.chatPostedKeyRotated
        ? "rotated_local_only_verified"
        : "reject_and_rotate",
      allowedPermissionSetBeforePromotion: ["read"],
      blockedPermissionSetBeforePromotion: ["trade", "withdraw"],
      ipAllowlistRequiredForTradeOrWithdraw: true,
      keyPostedInChatMustBeRevoked: !credentialPolicyState.chatPostedKeyRotated,
      chatPostedKeyRotated: credentialPolicyState.chatPostedKeyRotated,
      withdrawPermissionAbsent: credentialPolicyState.withdrawPermissionAbsent,
      ipAllowlistSafe: credentialPolicyState.ipAllowlistSafe,
      rotationReceipt: {
        pathHint: rotationReceipt.pathHint,
        exists: rotationReceipt.exists,
        code: rotationReceipt.code,
        schemaOk: rotationReceipt.schemaOk,
        createdAt: rotationReceipt.createdAt || "",
        revokedChatSuppliedKey: rotationReceipt.revokedChatSuppliedKey,
        newKeyStoredLocalOnly: rotationReceipt.newKeyStoredLocalOnly,
        newKeyNeverPastedToChat: rotationReceipt.newKeyNeverPastedToChat,
        permissionSet: rotationReceipt.permissionSet,
        tradePermission: rotationReceipt.tradePermission,
        withdrawPermission: rotationReceipt.withdrawPermission,
        ipAllowlistConfigured: rotationReceipt.ipAllowlistConfigured,
      },
    },
    commands: {
      executed: [
        "okx --version",
        "okx config show",
        `okx market ticker ${symbol} --json`,
        liveProfile ? `okx --profile ${liveProfile} account config` : "live profile missing",
        demoProfile ? `okx --profile ${demoProfile} account config` : "demo profile missing",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
      ],
    },
    nextSafeTask: demoCode.endsWith("_401")
      ? "修復 demo API key，填入 .okx/config.toml 的 [profiles.demo]，再重跑 okx:api-status。"
      : liveCode === "live_ok"
        ? "建立 OpenClaw OKX dry-run order proposal gate；只產生提案，不送單。"
        : "Demo 模式已就緒。如需 Live 模式，請至 OKX 後台建立 Live API Key 並填入 [profiles.main]。",
  };
}

async function main() {
  const report = await buildOkxApiStatusGate({
    symbol: argValue("--symbol", DEFAULT_SYMBOL),
  });
  const outputPath = path.resolve(argValue("--output", DEFAULT_REPORT_PATH));
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(outputPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.summary_zh_tw}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `okx api status gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
