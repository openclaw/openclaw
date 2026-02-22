import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateEvmAccount, hasWallet } from '../client.js';

test('getOrCreateEvmAccount generates ephemeral wallet when no key set', () => {
  // Save and clear env.
  const saved = process.env.EVM_PRIVATE_KEY;
  const savedFile = process.env.EVM_PRIVATE_KEY_FILE;
  delete process.env.EVM_PRIVATE_KEY;
  delete process.env.EVM_PRIVATE_KEY_FILE;

  try {
    const result = getOrCreateEvmAccount();
    assert.ok(result.account);
    assert.ok(result.account.address.startsWith('0x'));
    assert.equal(result.ephemeral, true);
    assert.equal(result.source, 'ephemeral');
  } finally {
    if (saved !== undefined) process.env.EVM_PRIVATE_KEY = saved;
    if (savedFile !== undefined) process.env.EVM_PRIVATE_KEY_FILE = savedFile;
  }
});

test('getOrCreateEvmAccount uses explicit private key', () => {
  // Use a well-known test private key.
  const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const result = getOrCreateEvmAccount({ privateKey: testKey });
  assert.ok(result.account);
  assert.equal(result.ephemeral, false);
  assert.equal(result.source, 'env');
});

test('hasWallet returns false when no key configured', () => {
  const saved = process.env.EVM_PRIVATE_KEY;
  const savedFile = process.env.EVM_PRIVATE_KEY_FILE;
  delete process.env.EVM_PRIVATE_KEY;
  delete process.env.EVM_PRIVATE_KEY_FILE;

  try {
    assert.equal(hasWallet(), false);
  } finally {
    if (saved !== undefined) process.env.EVM_PRIVATE_KEY = saved;
    if (savedFile !== undefined) process.env.EVM_PRIVATE_KEY_FILE = savedFile;
  }
});

test('hasWallet returns true when EVM_PRIVATE_KEY is set', () => {
  const saved = process.env.EVM_PRIVATE_KEY;
  process.env.EVM_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  try {
    assert.equal(hasWallet(), true);
  } finally {
    if (saved !== undefined) process.env.EVM_PRIVATE_KEY = saved;
    else delete process.env.EVM_PRIVATE_KEY;
  }
});
