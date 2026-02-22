import test from 'node:test';
import assert from 'node:assert/strict';
import { matchQuery, scoreServices, normalizeCoingeckoId } from '../intent-router.js';

const SERVICES = [
  { id: 'crypto-price', name: 'Crypto Price Feed', description: 'Real-time cryptocurrency prices for any coin', price: '$0.001', path: '/api/crypto/price', method: 'GET' },
  { id: 'crypto-markets', name: 'Crypto Market Data', description: 'Market rankings with price volume market cap', price: '$0.002', path: '/api/crypto/markets', method: 'GET' },
  { id: 'crypto-trending', name: 'Trending Crypto', description: 'Currently trending coins', price: '$0.001', path: '/api/crypto/trending', method: 'GET' },
  { id: 'crypto-search', name: 'Crypto Search', description: 'Search for a coin by name or symbol', price: '$0.001', path: '/api/crypto/search', method: 'GET' },
  { id: 'crypto-history', name: 'Crypto Historical Data', description: 'Historical price data', price: '$0.003', path: '/api/crypto/history', method: 'GET' },
  { id: 'image-fast', name: 'Fast Image Generation', description: 'Quick image generation', price: '$0.015', path: '/api/image/fast', method: 'POST' },
  { id: 'image-quality', name: 'Quality Image Generation', description: 'High-quality image generation', price: '$0.05', path: '/api/image/quality', method: 'POST' },
  { id: 'image-text', name: 'Text-in-Image', description: 'Image with text rendering logos', price: '$0.12', path: '/api/image/text', method: 'POST' },
  { id: 'code-run', name: 'Code Execution', description: 'Run code Python JavaScript Bash', price: '$0.005', path: '/api/code/run', method: 'POST' },
  { id: 'wallet-balances', name: 'Wallet Balances', description: 'Token balances for any wallet', price: '$0.005', path: '/api/wallet/balances', method: 'POST' },
  { id: 'wallet-transactions', name: 'Wallet Transactions', description: 'Transaction history wallet activity', price: '$0.005', path: '/api/wallet/transactions', method: 'POST' },
  { id: 'ens-resolve', name: 'ENS Resolve', description: 'Resolve ENS name to address', price: '$0.001', path: '/api/ens/resolve', method: 'GET' },
  { id: 'llm-llama', name: 'Llama 3.3', description: 'Meta open-source model', price: '$0.002', path: '/api/llm/llama', method: 'POST' },
  { id: 'llm-gpt-4o', name: 'GPT-4o', description: 'OpenAI flagship model', price: '$0.04', path: '/api/llm/gpt-4o', method: 'POST' },
  { id: 'web-scrape', name: 'Web Scrape', description: 'Scrape any URL', price: '$0.005', path: '/api/web/scrape', method: 'GET' },
  { id: 'transcribe', name: 'Audio Transcription', description: 'Convert audio to text transcribe', price: '$0.10', path: '/api/transcribe', method: 'POST' },
  { id: 'ipfs-pin', name: 'IPFS Pin', description: 'Pin to IPFS', price: '$0.01', path: '/api/ipfs/pin', method: 'POST' },
  { id: 'tts-openai', name: 'Text-to-Speech', description: 'Convert text to speech TTS', price: '$0.01', path: '/api/tts/openai', method: 'POST' },
  { id: 'video-fast', name: 'Fast Video', description: 'Video generation', price: '$0.30', path: '/api/video/fast', method: 'POST' },
  { id: 'embeddings', name: 'Text Embeddings', description: 'Generate text embeddings', price: '$0.001', path: '/api/embeddings', method: 'POST' },
];

// ---- Crypto price matching ----

test('matches "price of bitcoin" to crypto-price', () => {
  const m = matchQuery('price of bitcoin', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-price');
  assert.equal(m.params.ids, 'bitcoin');
});

test('matches "btc" to crypto-price', () => {
  const m = matchQuery('btc', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-price');
  assert.equal(m.params.ids, 'bitcoin');
});

test('matches "ethereum price" to crypto-price', () => {
  const m = matchQuery('ethereum price', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-price');
  assert.equal(m.params.ids, 'ethereum');
});

test('matches "what\'s the price of sol" to crypto-price', () => {
  const m = matchQuery("what's the price of sol", SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-price');
  assert.equal(m.params.ids, 'solana');
});

// ---- Trending, search, history ----

test('matches "trending" to crypto-trending', () => {
  const m = matchQuery('show me trending crypto', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-trending');
});

test('matches "search solana" to crypto-search', () => {
  const m = matchQuery('search for solana', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-search');
});

test('matches "history of eth 90d" to crypto-history', () => {
  const m = matchQuery('history of eth 90d', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'crypto-history');
  assert.equal(m.params.days, '90');
});

// ---- Image ----

test('matches "generate an image of a sunset" to image-fast', () => {
  const m = matchQuery('generate an image of a sunset', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'image-fast');
  assert.ok(m.params.prompt);
});

test('matches "image quality a mountain" to image-quality', () => {
  const m = matchQuery('image quality a mountain landscape', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'image-quality');
});

test('matches "logo" to image-text', () => {
  const m = matchQuery('create a logo with text ACME', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'image-text');
});

// ---- Wallet ----

test('matches "wallet activity of vitalik.eth" to wallet-transactions', () => {
  const m = matchQuery('wallet activity of vitalik.eth on base', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'wallet-transactions');
  assert.equal(m.params.address, 'vitalik.eth');
  assert.equal(m.params.chain, 'base');
});

test('matches "balance" to wallet-balances', () => {
  const m = matchQuery('wallet balance on ethereum', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'wallet-balances');
});

// ---- Code ----

test('matches "run python code" to code-run', () => {
  const m = matchQuery('run this python code print(42)', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'code-run');
});

// ---- LLM ----

test('matches "ask llama" to llm-llama', () => {
  const m = matchQuery('ask llama to summarize x402', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'llm-llama');
});

test('matches "gpt explain" to llm-gpt-4o', () => {
  const m = matchQuery('ask gpt to explain quantum computing', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'llm-gpt-4o');
});

// ---- ENS ----

test('matches ENS resolve', () => {
  const m = matchQuery('resolve vitalik.eth', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'ens-resolve');
  assert.equal(m.params.name, 'vitalik.eth');
});

// ---- Web ----

test('matches "scrape this url" to web-scrape', () => {
  const m = matchQuery('scrape https://example.com', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'web-scrape');
  assert.equal(m.params.url, 'https://example.com');
});

// ---- Audio ----

test('matches "transcribe" to transcribe', () => {
  const m = matchQuery('transcribe this audio file', SERVICES);
  assert.ok(m);
  assert.equal(m.service.id, 'transcribe');
});

// ---- No match ----

test('returns null for unmatched queries', () => {
  const m = matchQuery('tell me a joke about cats', SERVICES);
  assert.equal(m, null);
});

test('returns null for empty query', () => {
  assert.equal(matchQuery('', SERVICES), null);
  assert.equal(matchQuery(null, SERVICES), null);
});

// ---- Helpers ----

test('normalizeCoingeckoId maps common symbols', () => {
  assert.equal(normalizeCoingeckoId('btc'), 'bitcoin');
  assert.equal(normalizeCoingeckoId('ETH'), 'ethereum');
  assert.equal(normalizeCoingeckoId('unknown-token'), 'unknown-token');
});

test('scoreServices returns empty for no tokens', () => {
  const scores = scoreServices('', SERVICES);
  assert.equal(scores.length, 0);
});
