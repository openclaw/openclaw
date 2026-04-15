/**
 * targets.ts 单元测试
 *
 * 测试范围：looksLikeYuanbaoId、parseTarget
 */

import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeYuanbaoId, parseTarget } from "./targets.js";

// ============ looksLikeYuanbaoId ============

void test("looksLikeYuanbaoId 识别有效的 Base64 格式 ID", () => {
  // 长度 >= 16，长度是 4 的倍数，仅 Base64 字符集
  assert.equal(looksLikeYuanbaoId("YWJjZGVmZ2hpamts"), true);
  assert.equal(looksLikeYuanbaoId("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4"), true);
  assert.equal(looksLikeYuanbaoId("Ab1Cd2Ef3Gh4Ij5K"), true);
});

void test("looksLikeYuanbaoId 拒绝无效 ID", () => {
  // 太短
  assert.equal(looksLikeYuanbaoId("abc123"), false);
  assert.equal(looksLikeYuanbaoId(""), false);

  // 长度不是 4 的倍数
  assert.equal(looksLikeYuanbaoId("abcdefghijklmnopq"), false);

  // 包含非法字符
  assert.equal(looksLikeYuanbaoId("ABCDEFghijklmn!@"), false);
});

// ============ parseTarget ============

void test("parseTarget 解析群聊目标", () => {
  const result = parseTarget("group:test-group-123");
  assert.equal(result.target, "test-group-123");
  assert.equal(result.sessionKey, "group:test-group-123");
});

void test("parseTarget 解析 C2C 目标", () => {
  // 使用有效的 Base64 格式 ID（长度 16，4 的倍数）
  const validId = "YWJjZGVmZ2hpamts";
  const result = parseTarget(validId);
  assert.equal(result.target, validId);
  assert.equal(result.sessionKey, `direct:${validId}`);
});

void test("parseTarget 去除 yuanbao: 前缀", () => {
  const result = parseTarget("yuanbao:group:my-group");
  assert.equal(result.target, "my-group");
});

void test("parseTarget 去除 user: 和 direct: 前缀", () => {
  const validId = "YWJjZGVmZ2hpamts";
  const result1 = parseTarget(`user:${validId}`);
  assert.equal(result1.target, validId);

  const result2 = parseTarget(`direct:${validId}`);
  assert.equal(result2.target, validId);
});
