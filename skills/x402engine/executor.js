// Invisible service access executor.
// Flow: user query → discover catalog → match intent → policy preflight → paid fetch → result.

import { createRequire } from 'node:module';
import { fetchCatalog } from './discovery.js';
import { matchQuery } from './intent-router.js';
import { getOrCreateEvmAccount, hasWallet, createPaidFetch } from './client.js';

const require = createRequire(import.meta.url);
const CODES = require('./reason-codes.cjs');

/**
 * Execute a user query against the x402engine service catalog.
 *
 * @param {string} userQuery - Natural language query (e.g. "price of bitcoin")
 * @param {object} opts
 * @param {string} opts.policyPath   - Policy file path
 * @param {string} opts.statePath    - State file path
 * @param {string} opts.privateKey   - EVM private key override
 * @param {boolean} opts.autopreflight - Enable policy preflight (default: true)
 * @param {Function} opts.fetchImpl  - fetch override (testing)
 * @returns {{ ok: boolean, data?: any, service?: object, error?: string, reason?: string }}
 */
export async function executeQuery(userQuery, {
  policyPath,
  statePath,
  privateKey,
  autopreflight = true,
  fetchImpl,
} = {}) {
  // 1. Check wallet availability.
  if (!privateKey && !hasWallet()) {
    return {
      ok: false,
      reason: CODES.WALLET_UNDERFUNDED,
      error: 'No EVM wallet configured. Set EVM_PRIVATE_KEY or EVM_PRIVATE_KEY_FILE to enable paid API access.',
    };
  }

  // 2. Discover service catalog.
  let catalog;
  try {
    catalog = await fetchCatalog({ fetchImpl });
  } catch (err) {
    return {
      ok: false,
      reason: 'DISCOVERY_FAILED',
      error: `Failed to fetch service catalog: ${err.message}`,
    };
  }

  // 3. Match user query to a service.
  const match = matchQuery(userQuery, catalog.services);
  if (!match) {
    return {
      ok: false,
      reason: CODES.SERVICE_NOT_FOUND,
      error: `No matching service found for query: "${userQuery}"`,
    };
  }

  const { service, params } = match;

  // 4. Create paid fetch with wallet + autopreflight.
  let paidFetch;
  try {
    const { account } = getOrCreateEvmAccount({ privateKey });
    paidFetch = createPaidFetch({
      account,
      policyPath: policyPath || process.env.X402_POLICY_PATH,
      statePath: statePath || process.env.X402_STATE_PATH,
      autopreflight,
    });
  } catch (err) {
    return {
      ok: false,
      reason: CODES.WALLET_UNDERFUNDED,
      error: `Wallet setup failed: ${err.message}`,
    };
  }

  // 5. Execute the paid request.
  const baseUrl = catalog.baseUrl;
  const url = new URL(service.path, baseUrl);
  const method = (service.method || 'GET').toUpperCase();

  try {
    let res;
    if (method === 'GET') {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && typeof v !== 'object') {
          url.searchParams.set(k, String(v));
        }
      }
      res = await paidFetch(url.toString(), { method: 'GET' });
    } else {
      res = await paidFetch(url.toString(), {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(params),
      });
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: res.status === 402 ? CODES.WALLET_UNDERFUNDED : 'UPSTREAM_ERROR',
        error: `Service ${service.id} returned HTTP ${res.status}`,
        data,
        service: { id: service.id, name: service.name, price: service.price },
      };
    }

    return {
      ok: true,
      data,
      service: { id: service.id, name: service.name, price: service.price },
    };
  } catch (err) {
    const isPolicyBlock = err.message?.includes('Payment blocked') || err.message?.includes('Autopreflight');
    return {
      ok: false,
      reason: isPolicyBlock ? 'POLICY_BLOCKED' : 'FETCH_ERROR',
      error: err.message,
      service: { id: service.id, name: service.name, price: service.price },
    };
  }
}

export { fetchCatalog } from './discovery.js';
export { matchQuery } from './intent-router.js';
