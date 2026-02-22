// Wrap @x402/fetch with wallet (from EVM_PRIVATE_KEY env) and policy
// autopreflight in the payment selector callback.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const {
  loadPolicy,
  evaluateRequest,
  loadState,
  saveState,
  applySuccessToState,
} = require('./policy-engine.cjs');

export const BASE_MAINNET_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const PAYGATE_ALLOWLIST = [
  '0x7dd5Be069f2d2eAd75eC7C3423B116fF043c2629',
  'Gzehfseq1k9AcHFSoV7qHmDGQx92nLMw78XXdqVWQQWa',
];

// ---- Wallet management ----

function normalizePrivateKey(pk) {
  let s = String(pk || '').trim();
  if (!s) return null;
  if (!s.startsWith('0x')) s = `0x${s}`;
  return s;
}

function loadPrivateKeyFromFile(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return null;

  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`Failed to read EVM private key file at ${p}: ${e.message}`);
  }

  const text = raw.trim();
  if (!text) throw new Error(`Empty EVM private key file at ${p}.`);

  if (text.startsWith('{')) {
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Invalid JSON in EVM private key file at ${p}.`);
    }
    const pk = normalizePrivateKey(json?.privateKey);
    if (!pk) throw new Error(`Missing "privateKey" in JSON key file at ${p}.`);
    return pk;
  }

  return normalizePrivateKey(text);
}

/**
 * Load or generate an EVM account.
 * Priority: explicit key > env EVM_PRIVATE_KEY > env EVM_PRIVATE_KEY_FILE > ephemeral.
 */
export function getOrCreateEvmAccount({ privateKey } = {}) {
  let pk = normalizePrivateKey(privateKey) || normalizePrivateKey(process.env.EVM_PRIVATE_KEY);
  let ephemeral = false;
  let source = pk ? 'env' : null;

  if (!pk) {
    const pkFile = process.env.EVM_PRIVATE_KEY_FILE;
    if (pkFile) {
      pk = loadPrivateKeyFromFile(pkFile);
      if (pk) source = 'file';
    }
  }

  if (!pk) {
    const bytes = crypto.randomBytes(32);
    pk = `0x${bytes.toString('hex')}`;
    ephemeral = true;
    source = 'ephemeral';
  }

  const account = privateKeyToAccount(pk);
  return { account, ephemeral, source };
}

/** Check if a real wallet is configured. */
export function hasWallet() {
  return Boolean(
    normalizePrivateKey(process.env.EVM_PRIVATE_KEY) ||
    process.env.EVM_PRIVATE_KEY_FILE,
  );
}

// ---- Payment selector with autopreflight ----

function preferBaseUsdc(_version, accepts) {
  if (!accepts?.length) throw new Error('No payment options provided by paygate');
  const baseUsdc = accepts.find(
    (a) => a?.network === 'eip155:8453' && String(a?.asset || '').toLowerCase() === BASE_MAINNET_USDC,
  );
  return baseUsdc ?? accepts[0];
}

function deriveAssetSymbol(accept) {
  const sym = String(accept?.assetSymbol || accept?.symbol || '').trim();
  if (sym) return sym.toUpperCase();
  const asset = String(accept?.asset || '').trim();
  if (!asset) return '';
  if (asset.toLowerCase() === BASE_MAINNET_USDC) return 'USDC';
  if (!asset.startsWith('0x')) return asset.toUpperCase();
  return asset;
}

function deriveAmount(accept) {
  for (const v of [accept?.maxAmountRequired, accept?.amount, accept?.maxAmount, accept?.value]) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return String(n);
  }
  return null;
}

function deriveRecipient(accept) {
  const v = accept?.payTo || accept?.recipient || accept?.receiver || accept?.payee;
  return String(v || '').trim() || '0x0000000000000000000000000000000000000000';
}

function derivePolicyRequest(accept) {
  const chain = String(accept?.network || accept?.chain || '').trim();
  const asset = deriveAssetSymbol(accept);
  const amount = deriveAmount(accept);
  const to = deriveRecipient(accept);
  if (!chain || !asset || amount == null) {
    throw new Error('Cannot derive chain/asset/amount from payment requirements');
  }
  return { chain, asset, amount, to };
}

function envFlagEnabled(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

/**
 * Run policy preflight against a selected payment accept option.
 * Throws if policy blocks the payment.
 */
export function autopreflightCheck({ accept, policyPath, statePath, now = new Date() }) {
  if (!accept) return { bypassed: true };

  const resolvedPolicyPath = policyPath || process.env.X402_POLICY_PATH;
  if (!resolvedPolicyPath) return { bypassed: true, reason: 'no_policy_path' };

  const resolvedStatePath = statePath || process.env.X402_STATE_PATH;

  const policyResult = loadPolicy(resolvedPolicyPath);
  if (!policyResult.ok) {
    throw new Error(
      `Autopreflight policy unavailable (${policyResult?.decision?.reason || 'POLICY_INVALID'}). ` +
      `Fix policy config: ${resolvedPolicyPath}`,
    );
  }

  const request = derivePolicyRequest(accept);
  const state = loadState(resolvedStatePath);
  const decision = evaluateRequest({ policy: policyResult.policy, request, state, now });

  if (!decision.allow) {
    throw new Error(
      `Payment blocked (${decision.reason}): ${decision.details}. ` +
      `Top up budget or adjust policy: ${resolvedPolicyPath}`,
    );
  }

  const nextState = applySuccessToState({ policy: policyResult.policy, request, state, now });
  saveState(resolvedStatePath || '.x402engine-state.json', nextState);

  return { bypassed: false, request, decision };
}

/**
 * Create an @x402/fetch-wrapped fetch with wallet + autopreflight.
 */
export function createPaidFetch({
  account,
  policyPath,
  statePath,
  autopreflight = envFlagEnabled('X402_AUTOPREFLIGHT', true),
} = {}) {
  const signer = toClientEvmSigner(account);

  const selector = (version, accepts) => {
    const selected = preferBaseUsdc(version, accepts);
    if (autopreflight) {
      autopreflightCheck({ accept: selected, policyPath, statePath });
    }
    return selected;
  };

  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: 'eip155:*', client: new ExactEvmScheme(signer) },
    ],
    paymentRequirementsSelector: selector,
  });
}
