import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery } from '../executor.js';
import { resetCache } from '../discovery.js';

const MOCK_CATALOG = {
  baseUrl: 'https://x402engine.app',
  services: [
    { id: 'crypto-price', name: 'Crypto Price', description: 'Real-time cryptocurrency prices', price: '$0.001', path: '/api/crypto/price', method: 'GET' },
    { id: 'image-fast', name: 'Fast Image', description: 'Quick image generation', price: '$0.015', path: '/api/image/fast', method: 'POST' },
  ],
};

function makeCatalogFetch() {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(MOCK_CATALOG),
  });
}

test('executeQuery returns WALLET_UNDERFUNDED when no wallet configured', async () => {
  const saved = process.env.EVM_PRIVATE_KEY;
  const savedFile = process.env.EVM_PRIVATE_KEY_FILE;
  delete process.env.EVM_PRIVATE_KEY;
  delete process.env.EVM_PRIVATE_KEY_FILE;

  try {
    resetCache();
    const result = await executeQuery('price of bitcoin', {
      fetchImpl: makeCatalogFetch(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'WALLET_UNDERFUNDED');
  } finally {
    if (saved !== undefined) process.env.EVM_PRIVATE_KEY = saved;
    if (savedFile !== undefined) process.env.EVM_PRIVATE_KEY_FILE = savedFile;
  }
});

test('executeQuery returns SERVICE_NOT_FOUND for unmatched query', async () => {
  resetCache();
  const result = await executeQuery('tell me a joke about cats', {
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    fetchImpl: makeCatalogFetch(),
    autopreflight: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SERVICE_NOT_FOUND');
});

test('executeQuery returns DISCOVERY_FAILED when catalog unreachable', async () => {
  resetCache();
  const failFetch = async () => { throw new Error('network error'); };
  const result = await executeQuery('price of bitcoin', {
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    fetchImpl: failFetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DISCOVERY_FAILED');
});

test('executeQuery proceeds past matching with valid query and wallet', async () => {
  // This test verifies the executor gets past discovery + matching + wallet setup.
  // It will fail at the actual paid HTTP call (network), but that means matching worked.
  resetCache();
  const result = await executeQuery('price of bitcoin', {
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    fetchImpl: makeCatalogFetch(),
    autopreflight: false,
  });
  // The result should either succeed (unlikely without real server) or fail with
  // FETCH_ERROR/UPSTREAM_ERROR (meaning it got past discovery+matching+wallet).
  assert.ok(
    result.ok ||
    result.reason === 'FETCH_ERROR' ||
    result.reason === 'UPSTREAM_ERROR' ||
    result.reason === 'WALLET_UNDERFUNDED',
    `unexpected reason: ${result.reason}`,
  );
  // If it has a service, verify it matched correctly.
  if (result.service) {
    assert.equal(result.service.id, 'crypto-price');
  }
});
