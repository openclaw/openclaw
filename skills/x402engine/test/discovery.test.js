import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalog, resetCache, getCachedCatalog } from '../discovery.js';

const MOCK_CATALOG = {
  baseUrl: 'https://x402engine.app',
  services: [
    { id: 'crypto-price', name: 'Crypto Price', description: 'Real-time prices', price: '$0.001', path: '/api/crypto/price', method: 'GET' },
    { id: 'image-fast', name: 'Fast Image', description: 'Quick image generation', price: '$0.015', path: '/api/image/fast', method: 'POST' },
  ],
};

function makeFetchImpl(json, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  });
}

test('fetchCatalog returns parsed catalog', async () => {
  resetCache();
  const catalog = await fetchCatalog({
    fetchImpl: makeFetchImpl(MOCK_CATALOG),
    discoveryUrl: 'https://test.local/x402.json',
  });
  assert.equal(catalog.baseUrl, 'https://x402engine.app');
  assert.equal(catalog.services.length, 2);
  assert.equal(catalog.source, 'remote');
});

test('fetchCatalog uses cache within TTL', async () => {
  resetCache();
  let callCount = 0;
  const countingFetch = async (...args) => {
    callCount++;
    return makeFetchImpl(MOCK_CATALOG)(...args);
  };

  await fetchCatalog({ fetchImpl: countingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 1000 });
  await fetchCatalog({ fetchImpl: countingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 2000 });
  assert.equal(callCount, 1);
});

test('fetchCatalog bypasses cache when force=true', async () => {
  resetCache();
  let callCount = 0;
  const countingFetch = async (...args) => {
    callCount++;
    return makeFetchImpl(MOCK_CATALOG)(...args);
  };

  await fetchCatalog({ fetchImpl: countingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 1000 });
  await fetchCatalog({ fetchImpl: countingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 2000, force: true });
  assert.equal(callCount, 2);
});

test('fetchCatalog refreshes after TTL expires', async () => {
  resetCache();
  let callCount = 0;
  const countingFetch = async (...args) => {
    callCount++;
    return makeFetchImpl(MOCK_CATALOG)(...args);
  };

  await fetchCatalog({ fetchImpl: countingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 0 });
  // Default TTL is 60s = 60000ms
  await fetchCatalog({ fetchImpl: countingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 70000 });
  assert.equal(callCount, 2);
});

test('fetchCatalog falls back to stale cache on network failure', async () => {
  resetCache();
  // Seed cache.
  await fetchCatalog({ fetchImpl: makeFetchImpl(MOCK_CATALOG), discoveryUrl: 'https://test.local/x402.json', nowMs: 0 });

  // Force refresh with failing fetch.
  const failingFetch = async () => { throw new Error('network error'); };
  const catalog = await fetchCatalog({ fetchImpl: failingFetch, discoveryUrl: 'https://test.local/x402.json', nowMs: 999999, force: true });
  assert.equal(catalog.baseUrl, 'https://x402engine.app');
});

test('fetchCatalog throws if no cache and network fails', async () => {
  resetCache();
  const failingFetch = async () => { throw new Error('network error'); };
  await assert.rejects(
    () => fetchCatalog({ fetchImpl: failingFetch, discoveryUrl: 'https://test.local/x402.json' }),
    { message: /Discovery fetch failed/ },
  );
});

test('fetchCatalog throws on missing baseUrl', async () => {
  resetCache();
  await assert.rejects(
    () => fetchCatalog({ fetchImpl: makeFetchImpl({ services: [] }), discoveryUrl: 'https://test.local/x402.json' }),
    { message: /missing baseUrl/ },
  );
});

test('getCachedCatalog returns null when empty', () => {
  resetCache();
  assert.equal(getCachedCatalog(), null);
});
