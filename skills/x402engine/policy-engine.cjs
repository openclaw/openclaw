const fs = require('node:fs');
const path = require('node:path');
const CODES = require('./reason-codes.cjs');

function parseAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function normalizeAddress(addr) {
  return String(addr || '').trim().toLowerCase();
}

function dayKey(date = new Date(), timezone = 'UTC') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

function deny(reason, details) {
  return { allow: false, reason, details: details || reason };
}

function allow(details) {
  return { allow: true, reason: 'ALLOWED', details: details || 'Policy checks passed' };
}

function loadPolicy(policyPath) {
  if (!policyPath) {
    return { ok: false, decision: deny(CODES.POLICY_MISSING, 'Policy path not provided') };
  }
  if (!fs.existsSync(policyPath)) {
    return { ok: false, decision: deny(CODES.POLICY_MISSING, `Policy not found: ${policyPath}`) };
  }
  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (e) {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, `Policy unreadable: ${e.message}`) };
  }

  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (e) {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, `Policy JSON invalid: ${e.message}`) };
  }

  const validation = validatePolicy(policy);
  if (!validation.ok) return validation;
  return { ok: true, policy };
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, 'Policy must be an object') };
  }
  if (String(policy.version || '') !== '1') {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, 'Unsupported policy version (expected "1")') };
  }
  if (policy.mode !== 'enforce') {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, 'Policy mode must be "enforce"') };
  }
  if (!Array.isArray(policy.allowedChains) || policy.allowedChains.length === 0) {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, 'allowedChains must be a non-empty array') };
  }
  if (!policy.assets || typeof policy.assets !== 'object') {
    return { ok: false, decision: deny(CODES.POLICY_INVALID, 'assets must be an object') };
  }
  for (const chain of policy.allowedChains) {
    const chainAssets = policy.assets[chain];
    if (!chainAssets || typeof chainAssets !== 'object') {
      return { ok: false, decision: deny(CODES.POLICY_INVALID, `Missing assets definition for chain ${chain}`) };
    }
    for (const [asset, cfg] of Object.entries(chainAssets)) {
      const perTx = parseAmount(cfg?.maxPerTx);
      if (perTx === null) {
        return { ok: false, decision: deny(CODES.POLICY_INVALID, `Invalid maxPerTx for ${chain}/${asset}`) };
      }
      if (cfg?.dailyCap?.enabled) {
        const daily = parseAmount(cfg.dailyCap.amount);
        if (daily === null) {
          return { ok: false, decision: deny(CODES.POLICY_INVALID, `Invalid daily cap amount for ${chain}/${asset}`) };
        }
      }
    }
  }

  const recipientMode = policy?.recipientPolicy?.mode;
  if (recipientMode === 'allowlist') {
    if (!Array.isArray(policy.recipientPolicy.allow) || policy.recipientPolicy.allow.length === 0) {
      return { ok: false, decision: deny(CODES.POLICY_INVALID, 'recipientPolicy.allow must be non-empty in allowlist mode') };
    }
  }

  return { ok: true };
}

function evaluateRequest({ policy, request, state = {}, now = new Date() }) {
  const amount = parseAmount(request.amount);
  if (amount === null) return deny(CODES.POLICY_INVALID, 'Request amount invalid');

  if (!policy.allowedChains.includes(request.chain)) {
    return deny(CODES.CHAIN_DENIED, `Chain ${request.chain} is not allowed`);
  }

  const chainAssets = policy.assets[request.chain] || {};
  const assetCfg = chainAssets[request.asset];
  if (!assetCfg) {
    return deny(CODES.ASSET_DENIED, `Asset ${request.asset} is not allowed on ${request.chain}`);
  }

  const transferAllowed = policy?.actions?.allowTransfers !== false;
  if (!transferAllowed) {
    return deny(CODES.ACTION_DENIED, 'Transfers are disabled by policy.actions.allowTransfers');
  }

  if (policy?.recipientPolicy?.mode === 'allowlist') {
    const allow = new Set((policy.recipientPolicy.allow || []).map(normalizeAddress));
    if (!allow.has(normalizeAddress(request.to))) {
      return deny(CODES.RECIPIENT_DENIED, `Recipient ${request.to} is not in allowlist`);
    }
  }

  const maxPerTx = parseAmount(assetCfg.maxPerTx);
  if (amount > maxPerTx) {
    return deny(CODES.PER_TX_EXCEEDED, `Amount ${amount} exceeds maxPerTx ${maxPerTx}`);
  }

  const dailyCfg = assetCfg.dailyCap || { enabled: false };
  if (dailyCfg.enabled) {
    const key = `${request.chain}:${request.asset}:${dayKey(now, dailyCfg.timezone || 'UTC')}`;
    const spent = Number(state.dailySpend?.[key] || 0);
    const cap = parseAmount(dailyCfg.amount);
    if (spent + amount > cap) {
      return deny(CODES.DAILY_CAP_EXCEEDED, `Projected daily spend ${spent + amount} exceeds cap ${cap}`);
    }
  }

  const minIntervalSeconds = Number(policy?.rateLimits?.minIntervalSeconds || 0);
  if (minIntervalSeconds > 0 && state.lastTxAtMs) {
    const elapsed = Math.max(0, now.getTime() - Number(state.lastTxAtMs));
    if (elapsed < minIntervalSeconds * 1000) {
      return deny(CODES.RATE_LIMITED, `Minimum interval ${minIntervalSeconds}s not reached`);
    }
  }

  return allow('All policy checks passed');
}

function applySuccessToState({ policy, request, state = {}, now = new Date() }) {
  const next = JSON.parse(JSON.stringify(state || {}));
  if (!next.dailySpend) next.dailySpend = {};
  next.lastTxAtMs = now.getTime();

  const cfg = policy.assets?.[request.chain]?.[request.asset];
  if (cfg?.dailyCap?.enabled) {
    const key = `${request.chain}:${request.asset}:${dayKey(now, cfg.dailyCap.timezone || 'UTC')}`;
    const current = Number(next.dailySpend[key] || 0);
    next.dailySpend[key] = current + Number(request.amount);
  }
  return next;
}

function loadState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(statePath, state) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

module.exports = {
  loadPolicy,
  validatePolicy,
  evaluateRequest,
  applySuccessToState,
  loadState,
  saveState,
  dayKey,
};
