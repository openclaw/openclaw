# PR 审查响应模板

快速响应 GitHub bot 审查意见的模板集合。

---

## 🤖 Greptile 审查响应

### 场景 1: 代码质量建议

**Greptile 评论**:

```
**Duplicate changelog entries**
This PR adds two entries that already exist verbatim further down in CHANGELOG.md.
```

**响应模板**:

```markdown
@Greptile Thanks for catching that! Fixed by removing the duplicate entries in commit <SHA>.
```

**后续操作**:

```bash
# 1. 编辑 CHANGELOG.md 删除重复项
# 2. 提交修复
git add CHANGELOG.md
git commit --amend --no-edit  # 或新提交
git push --force-with-lease

# 3. 回复审查
# 在评论中@Greptile 确认已修复
```

---

### 场景 2: 安全建议

**Greptile 评论**:

```
**Potential null pointer dereference**
The code accesses `config.value` without checking if config is null.
```

**响应模板**:

````markdown
@Greptile Good catch! Added null check in commit <SHA>. The fix:

```typescript
// Before
const value = config.value;

// After
const value = config?.value ?? defaultValue;
```
````

```

---

## 🛡️ Aisle Security 审查响应

### 场景 1: 未处理的 Promise 拒绝

**Aisle 评论**:
```

## 🟡 Unhandled promise rejection

The new request-timeout implementation schedules a setTimeout() that will reject
the request promise. If ws.send() throws synchronously, the promise is never returned.

````

**响应模板**:
```markdown
@aisle-research-bot Thanks for the security analysis! Fixed by wrapping ws.send() in try/catch:

```typescript
try {
  this.ws!.send(JSON.stringify(frame));
} catch (e) {
  if (timeout) clearTimeout(timeout);
  this.pending.delete(id);
  reject(e);
}
````

Committed in <SHA>. This ensures no orphaned promises can trigger unhandledRejection.

````

**后续操作**:
```bash
# 1. 立即修复安全问题
# 2. 添加测试覆盖
# 3. 提交并推送
# 4. 回复审查确认已修复
````

---

### 场景 2: SSRF 风险

**Aisle 评论**:

```
## 🟠 Server-Side Request Forgery (SSRF)
User-controlled URL is fetched without protocol validation.
```

**响应模板**:

````markdown
@aisle-research-bot Addressed by adding protocol allowlist:

```typescript
const allowedProtocols = ["https:", "http:"];
const parsed = new URL(userUrl);
if (!allowedProtocols.includes(parsed.protocol)) {
  throw new Error("Invalid protocol");
}
```
````

Also added blocklist for internal IPs (127.0.0.0/8, 10.0.0.0/8, etc.).
Fixed in <SHA>.

```

---

## 💡 Codex 审查响应

### 场景 1: 代码风格建议

**Codex 评论**:
```

Consider using const instead of let for variables that are never reassigned.

````

**响应模板**:
```markdown
@codex Good suggestion! Changed to const in <SHA>.
````

---

### 场景 2: 测试覆盖建议

**Codex 评论**:

```
This function lacks test coverage for edge cases (empty input, null values).
```

**响应模板**:

````markdown
@codex Added comprehensive test coverage in <SHA>:

```typescript
it("handles empty input", () => {
  expect(fn("")).toBe(expected);
});

it("handles null values", () => {
  expect(fn(null)).toBe(expected);
});
```
````

````

---

## ⏰ 响应时间承诺

| 审查类型 | 响应时间 | 修复时间 |
|---------|---------|---------|
| 🛡️ Aisle Security | **<15 分钟** | <1 小时 |
| 🤖 Greptile | <30 分钟 | <2 小时 |
| 💡 Codex | <1 小时 | <4 小时 |
| 👤 人类审查者 | <2 小时 | <24 小时 |

---

## ✅ 审查响应检查清单

收到审查后：

- [ ] **5 分钟内** 确认收到审查（点赞或回复）
- [ ] **15 分钟内** 评估审查意见的合理性
- [ ] **30 分钟内** 开始修复（如适用）
- [ ] **修复后** 立即提交并推送
- [ ] **推送后** @审查者确认已修复
- [ ] **所有审查解决后** 请求重新审查

---

## 📝 完整响应示例

### 示例：多条评论批量响应

```markdown
## Review Response Summary

Thanks @greptile-apps, @aisle-research-bot, and @codex for the thorough reviews!

### Addressed Issues:

1. **Duplicate CHANGELOG entries** (Greptile)
   - ✅ Removed duplicates in commit a1b2c3d

2. **Unhandled promise rejection** (Aisle Security)
   - ✅ Added try/catch wrapper in commit e4f5g6h
   - ✅ Added regression test in commit i7j8k9l

3. **Use const instead of let** (Codex)
   - ✅ Changed 3 occurrences in commit m0n1o2p

4. **Missing edge case tests** (Codex)
   - ✅ Added 5 test cases covering null/empty/edge cases in commit q3r4s5t

### Verification:
- [x] pnpm test (all passing)
- [x] pnpm check (0 errors)
- [x] pnpm build (successful)

All review conversations have been resolved. Ready for re-review! 🚀
````

---

## 🚨 紧急情况处理

### 发现严重安全问题

如果审查指出严重安全问题：

1. **立即暂停**其他工作
2. **15 分钟内**评估风险
3. **30 分钟内**提交修复
4. **推送后** @维护者确认
5. **必要时**撤回 PR 重新设计

**响应模板**:

```markdown
@maintainers Critical security issue identified by @aisle-research-bot.
Proposing to:

1. Revert the risky change temporarily
2. Redesign with security-first approach
3. Re-submit as new PR with security review

Should I proceed with this plan?
```

---

## 📊 审查响应指标追踪

记录每次审查响应时间，持续改进：

| PR #  | 审查数量 | 平均响应时间 | 修复时间 | 结果      |
| ----- | -------- | ------------ | -------- | --------- |
| 45813 | 3        | 25 分钟      | 1.5 小时 | ✅ Merged |

目标：

- 平均响应时间 <30 分钟
- 平均修复时间 <2 小时
- 审查解决率 100%
