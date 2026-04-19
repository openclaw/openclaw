/**
 * targets.ts unit tests.
 *
 * Test scope: looksLikeYuanbaoId, parseTarget
 */

import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeYuanbaoId, parseTarget } from "./targets.js";

// ============ looksLikeYuanbaoId ============

void test("looksLikeYuanbaoId recognizes valid Base64 format IDs", () => {
  // Length >= 16, length is multiple of 4, Base64 charset only
  assert.equal(looksLikeYuanbaoId("YWJjZGVmZ2hpamts"), true);
  assert.equal(looksLikeYuanbaoId("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4"), true);
  assert.equal(looksLikeYuanbaoId("Ab1Cd2Ef3Gh4Ij5K"), true);
});

void test("looksLikeYuanbaoId rejects invalid IDs", () => {
  // Too short
  assert.equal(looksLikeYuanbaoId("abc123"), false);
  assert.equal(looksLikeYuanbaoId(""), false);

  // Length not multiple of 4
  assert.equal(looksLikeYuanbaoId("abcdefghijklmnopq"), false);

  // Contains illegal characters
  assert.equal(looksLikeYuanbaoId("ABCDEFghijklmn!@"), false);
});

// ============ parseTarget ============

void test("parseTarget parses group chat target", () => {
  const result = parseTarget("group:test-group-123");
  assert.equal(result.target, "test-group-123");
  assert.equal(result.sessionKey, "group:test-group-123");
});

void test("parseTarget parses C2C target", () => {
  // Valid Base64 format ID (length 16, multiple of 4)
  const validId = "YWJjZGVmZ2hpamts";
  const result = parseTarget(validId);
  assert.equal(result.target, validId);
  assert.equal(result.sessionKey, `direct:${validId}`);
});

void test("parseTarget removes yuanbao: prefix", () => {
  const result = parseTarget("yuanbao:group:my-group");
  assert.equal(result.target, "my-group");
});

void test("parseTarget removes user: and direct: prefixes", () => {
  const validId = "YWJjZGVmZ2hpamts";
  const result1 = parseTarget(`user:${validId}`);
  assert.equal(result1.target, validId);

  const result2 = parseTarget(`direct:${validId}`);
  assert.equal(result2.target, validId);
});
