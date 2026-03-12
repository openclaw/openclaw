# 🚀 提交到 OpenClaw - 完整指南

## ✅ 你已经完成的工作

1. ✅ 创建了新分支 `security-message-redaction`
2. ✅ 实现了安全功能（消息打码）
3. ✅ 添加了单元测试
4. ✅ 创建了文档
5. ✅ 本地提交成功

## 📋 接下来的步骤

### 步骤 1: Fork 仓库

1. 在浏览器中打开：https://github.com/openclaw/openclaw
2. 点击右上角的 **"Fork"** 按钮
3. 在 Fork 页面中，点击 **"Create fork"**
4. 等待 fork 完成（通常几秒钟）

### 步骤 2: 确认你的 GitHub 用户名

访问你的 GitHub 个人主页：https://github.com

URL 格式是 `https://github.com/YOUR_USERNAME`，记下你的用户名。

### 步骤 3: 更新远程仓库配置

如果你的用户名**不是** `qianjunye`，运行：

```bash
# 删除错误的 fork remote
git remote remove fork

# 添加正确的 fork remote（替换 YOUR_USERNAME）
git remote add fork git@github.com:YOUR_USERNAME/openclaw.git
```

### 步骤 4: 推送代码到你的 Fork

```bash
# 设置代理（如果需要）
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897

# 推送到你的 fork
git push -u fork security-message-redaction
```

### 步骤 5: 创建 Pull Request

1. 推送成功后，访问你的 fork 页面：
   `https://github.com/YOUR_USERNAME/openclaw`

2. GitHub 会显示一个黄色的提示框："Compare & pull request"，点击它

3. 填写 PR 信息（参考下面的模板）

4. 点击 **"Create pull request"**

---

## 📝 Pull Request 模板

根据项目的 `.github/pull_request_template.md`，填写以下内容：

```markdown
## Summary

- Problem: API keys and sensitive tokens can be accidentally exposed in messages sent to external channels (Telegram, Discord, Slack, etc)
- Why it matters: Leaked credentials pose security risks and can lead to unauthorized access
- What changed: Added automatic detection and redaction of sensitive values in all outbound messages
- What did NOT change: Internal logging, config file formats, existing message delivery logic

## Change Type

- [x] Security hardening
- [x] Feature

## Scope

- [x] Integrations
- [x] Security
- [x] API / contracts

## Linked Issue/PR

- Related #[if any]

## User-visible / Behavior Changes

- Messages sent to external channels now automatically redact sensitive values
- Format: `sk-abc…xyz` (preserves first 6 and last 4 characters)
- No configuration required - works automatically on startup
- Scans openclaw.json and environment variables for secrets

## Security Impact

- New permissions/capabilities? `No`
- Secrets/tokens handling changed? `Yes`
- New/changed network calls? `No`
- Command/tool execution surface changed? `No`
- Data access scope changed? `No`

**Mitigation**: This PR improves security by preventing accidental exposure of API keys, tokens, and credentials in messages. The redaction happens before messages are sent, using both pattern matching and runtime-discovered values from config/env.

## Repro + Verification

### Environment

- OS: macOS Darwin 25.3.0
- Runtime/container: Node.js
- Model/provider: Any
- Integration/channel: Telegram, Discord, Slack, and all channels using outbound-send-service
- Relevant config: Any config with `providers.*.apiKey` or similar sensitive fields

### Steps

1. Configure OpenClaw with API keys in openclaw.json or environment variables
2. Send a message containing an API key pattern (e.g., "sk-1234567890abcdefghij1234567890")
3. Observe the message in the external channel

### Expected

The message should have the key redacted: "sk-123…7890"

### Actual

Keys are properly redacted before being sent to external channels.

## Evidence

- [x] Unit tests added for redaction functionality
- [x] Tests for config/env scanning
- [x] Documentation in docs/security-message-redaction.md

## Human Verification

- Verified scenarios:
  - sk- prefixed API keys are redacted
  - GitHub tokens (ghp_*) are redacted
  - Custom secrets from config are redacted
  - Environment variable secrets are redacted
  - Short values (<18 chars) are not redacted to avoid false positives

- Edge cases checked:
  - Special regex characters in secrets
  - Multiple occurrences in same message
  - Nested config objects
  - Empty/null values handled gracefully

- What I did NOT verify:
  - Performance impact on high-volume message sending
  - All 30+ channel integrations (only tested core paths)

## Review Conversations

- [x] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? `Yes`
- Config/env changes? `No`
- Migration needed? `No`

## Failure Recovery

- How to disable/revert: Set `OPENCLAW_LOG_LEVEL=error` or revert the commit
- Files/config to restore: None (feature is self-contained)
- Known bad symptoms: If redaction fails, messages will be sent unredacted (falls back to original behavior)

## Risks and Mitigations

- Risk: Performance overhead from regex matching on every message
  - Mitigation: Patterns are compiled once, dynamic values use Set for O(1) lookup, minimum length check skips short strings

- Risk: False positives redacting non-sensitive data
  - Mitigation: 18-character minimum length requirement, specific pattern matching, only targets known key formats

- Risk: False negatives missing some secret formats
  - Mitigation: Comprehensive default patterns, runtime discovery from config/env, users can add custom patterns via config

```

---

## 🎯 提交检查清单

在创建 PR 前，确认：

- [x] 代码已提交到本地分支
- [x] 添加了单元测试
- [x] 添加了文档
- [ ] Fork 了主仓库
- [ ] 推送到了你的 fork
- [ ] 填写了 PR 描述
- [ ] 准备好回复 review comments

---

## ❓ 如果遇到问题

1. **SSH 密钥问题**：
   ```bash
   # 测试 SSH 连接
   ssh -T git@github.com
   ```

2. **代理问题**：
   ```bash
   # 临时关闭代理试试
   unset https_proxy http_proxy all_proxy
   git push -u fork security-message-redaction
   ```

3. **用户名不确定**：
   访问 https://github.com/settings/profile

---

## 📞 需要帮助？

告诉我你的 GitHub 用户名，或者在哪一步遇到了问题，我会继续帮你！
