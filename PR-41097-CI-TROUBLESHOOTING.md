# PR #41097 CI 故障排查

## 问题：detect-secrets 检查失败

### 当前状态

- **最新提交：** 3c256b985 (use obvious placeholder values for appSecret in tests)
- **推送时间：** 2026-03-10 09:14
- **CI 状态：** secrets 检查失败 (6s)

### 已尝试的修复

1. ✅ 使用 `TEST_SECRET_PLACEHOLDER` 代替 `test_secret`
2. ✅ 添加 `// pragma: allowlist secret` 注释（同一行）
3. ✅ 本地测试通过（9/9）
4. ✅ Lint 通过（0 warnings）

### 可能的原因

#### 原因 1: CI 使用不同的 detect-secrets 配置

CI 可能使用 `.pre-commit-config.yaml` 中的排除规则：

```yaml
exclude: '(^|/)(\.secrets\.baseline$|\.detect-secrets\.cfg$|\.pre-commit-config\.yaml$|apps/ios/fastlane/Fastfile$|.*\.test\.ts$)'
```

注意到 `.*\.test\.ts$` 被排除了！这意味着测试文件**不应该**被扫描。

#### 原因 2: CI 扫描的是变更的文件

CI 配置：

```bash
changed_files=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  [ -f "$path" ] || continue
  changed_files+=("$path")
done < <(git diff --name-only --diff-filter=ACMR "$BASE" HEAD)

if [ "${#changed_files[@]}" -gt 0 ]; then
  pre-commit run detect-secrets --files "${changed_files[@]}"
```

问题：`--files` 模式**会覆盖** `exclude` 规则！

#### 原因 3: pragma 注释格式问题

detect-secrets 要求 pragma 必须是：

- `# pragma: allowlist secret` (Python)
- `// pragma: allowlist secret` (JavaScript/TypeScript)

我们的格式是正确的，但可能需要检查是否有多余的空格或字符。

### 解决方案

#### 方案 A: 更新 .secrets.baseline（推荐）

```bash
cd /home/iouoi/openclaw
detect-secrets scan --update .secrets.baseline
git add .secrets.baseline
git commit -m "chore: update secrets baseline for test placeholders"
git push
```

#### 方案 B: 使用更明显的非密钥格式

```typescript
// 使用看起来完全不像密钥的值
appSecret: "NOT_A_REAL_SECRET_TEST_ONLY";
```

#### 方案 C: 在 CI 配置中添加排除

修改 `.pre-commit-config.yaml`：

```yaml
- repo: https://github.com/Yelp/detect-secrets
  rev: v1.5.0
  hooks:
    - id: detect-secrets
      exclude: '.*\.test\.ts$' # 排除所有测试文件
```

### 下一步行动

1. **检查 CI 日志** - 查看具体是哪个文件/哪一行触发警报
2. **更新 baseline** - 运行 `detect-secrets scan --update .secrets.baseline`
3. **重新推送** - 触发新的 CI 检查

### 参考

- detect-secrets 文档：https://github.com/Yelp/detect-secrets
- pragma 语法：https://github.com/Yelp/detect-secrets#pragma-allowlist-secret

---

_最后更新：2026-03-10 09:17_
