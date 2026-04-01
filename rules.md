# OpenClaw 贡献与安全规则

> 从 CONTRIBUTING.md 和 SECURITY.md 提取的核心要求
> 最后更新：2026-03-30

---

## 贡献规则

### PR 接受政策

| 类型           | 是否接受 | 说明                                   |
| -------------- | -------- | -------------------------------------- |
| Bug 修复       | ✅       | 直接开 PR                              |
| 小修复         | ✅       | 直接开 PR                              |
| 新功能/架构    | ⚠️       | 先在 GitHub Discussion 或 Discord 讨论 |
| 纯重构         | ❌       | 不接受（除非 maintainer 明确要求）     |
| 纯测试/CI 修复 | ❌       | 不接受（针对已知 main 失败）           |

### PR 前检查清单

- [ ] 本地测试通过：`pnpm build && pnpm check && pnpm test`
- [ ] 扩展改动跑 `pnpm test:extension <name>`
- [ ] 有 Codex 访问权限的跑 `codex review --base origin/main`
- [ ] 包含截图（问题前/修复后）
- [ ] 处理完 bot review 评论后自己 resolve
- [ ] PR 描述清晰说明 what & why
- [ ] 使用美式英语拼写

### AI 编码 PR 要求

如使用 Codex/Claude 等 AI 工具，必须在 PR 中标注：

- [ ] PR 标题/描述注明 AI-assisted
- [ ] 测试程度（未测试 / 轻度 / fully tested）
- [ ] 确认理解代码功能
- [ ] 如可能，包含 prompts 或 session logs

---

## 安全规则

### 漏洞报告要求

**必须包含 8 项：**

1. Title
2. Severity Assessment
3. Impact
4. Affected Component
5. Technical Reproduction
6. Demonstrated Impact
7. Environment
8. Remediation Advice

**快速 triage 还需：**

- 精确漏洞路径（file + function + line range）
- 测试版本详情（version/commit SHA）
- 可复现 PoC（针对 latest main 或 latest release）
- 证明不依赖 adversarial operators 共享 gateway
- Scope check 说明为何不在 Out of Scope 范围内

### 核心信任模型

**OpenClaw 是单用户可信操作员模型，不是多租户系统：**

- 通过 Gateway 认证的调用者 = 可信操作员
- Session ID 只是路由控制，**不是授权边界**
- 推荐：一用户一主机/VPS，一 gateway
- 多用户需隔离：分开 OS 用户/主机/gateway

### Out of Scope（不受理的报告）

- 纯 Prompt Injection（无边界 bypass）
- 可信操作员安装恶意插件后的行为
- 需要修改 `~/.openclaw` 或 workspace 文件才能利用
- Gateway HTTP 端点暴露（默认 loopback 部署）
- 共享 gateway 下多用户数据可见（预期行为）
- 纯 heuristic/parity drift（无边界 bypass）
- 依赖 pre-existing symlink/hardlink 状态
- 纯 ReDoS/DoS（需要 trusted operator config input）

### 安全配置建议

```json
{
  "gateway.bind": "loopback",
  "tools.exec.applyPatch.workspaceOnly": true,
  "tools.fs.workspaceOnly": true,
  "agents.defaults.sandbox.mode": "require"
}
```

**其他要求：**

- Node.js ≥ 22.12.0（含 CVE-2025-59466, CVE-2026-21636 修复）
- Docker 运行用 `--read-only --cap-drop=ALL`
- 定期跑 `detect-secrets scan`

---

## 维护者联系方式

| 领域                | Maintainer        | GitHub              |
| ------------------- | ----------------- | ------------------- |
| Benevolent Dictator | Peter Steinberger | @steipete           |
| Discord/Clawhub     | Shadow            | @thewilloftheshadow |
| Security            | Mariano Belinky   | @mbelinky           |
| Security            | Vincent Koc       | @vincentkoc         |
| Security            | Josh Avant        | @joshavant          |

**安全报告邮箱：** security@openclaw.ai

---

## 参考链接

- CONTRIBUTING.md: https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md
- SECURITY.md: https://github.com/openclaw/openclaw/blob/main/SECURITY.md
- Trust page: https://trust.openclaw.ai
- Discord: https://discord.gg/qkhbAGHRBT
