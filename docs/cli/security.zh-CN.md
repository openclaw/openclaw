---
summary: "`openclaw security` 命令行参考（审计和修复常见安全隐患）"
read_when:
  - 你想对配置/状态运行快速安全审计
  - 你想应用安全的“修复”建议（权限、收紧默认值）
title: "security"
---

# `openclaw security`

安全工具（审计 + 可选修复）。

相关：

- 安全指南：[安全](/gateway/security)

## 审计

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --deep --password <password>
openclaw security audit --deep --token <token>
openclaw security audit --fix
openclaw security audit --json
```

当多个 DM 发送者共享主会话时，审计会发出警告并推荐**安全 DM 模式**：对于共享收件箱，使用 `session.dmScope="per-channel-peer"`（或对于多账户频道，使用 `per-account-channel-peer`）。
这是为了协作/共享收件箱的加固。不建议使用由互不信任/对抗性操作员共享的单个网关；使用单独的网关（或单独的 OS 用户/主机）分离信任边界。
当配置表明可能存在共享用户入口时（例如开放 DM/群组策略、配置的群组目标或通配符发送者规则），它还会发出 `security.trust_model.multi_user_heuristic`，并提醒你 OpenClaw 默认是个人助手信任模型。
对于有意的共享用户设置，审计指导是对所有会话进行沙盒处理，保持文件系统访问的工作区范围，并在该运行时上保持个人/私人身份或凭证。
当小型模型（`<=300B`）在没有沙盒且启用了网络/浏览器工具的情况下使用时，它也会发出警告。
对于 webhook 入口，当 `hooks.token` 重用网关令牌、`hooks.token` 很短、`hooks.path="/"`、`hooks.defaultSessionKey` 未设置、`hooks.allowedAgentIds` 不受限制、启用请求 `sessionKey` 覆盖、以及在没有 `hooks.allowedSessionKeyPrefixes` 的情况下启用覆盖时，它会发出警告。
它还会在沙盒模式关闭时配置沙盒 Docker 设置、`gateway.nodes.denyCommands` 使用无效的模式样/未知条目（仅精确节点命令名称匹配，而非 shell 文本过滤）、`gateway.nodes.allowCommands` 明确启用危险节点命令、全局 `tools.profile="minimal"` 被代理工具配置文件覆盖、开放群组在没有沙盒/工作区保护的情况下公开运行时/文件系统工具、以及安装的扩展插件工具可能在宽松的工具策略下可访问时发出警告。
它还会标记 `gateway.allowRealIpFallback=true`（如果代理配置错误，存在标头欺骗风险）和 `discovery.mdns.mode="full"`（通过 mDNS TXT 记录泄漏元数据）。
当沙盒浏览器使用 Docker `bridge` 网络而没有 `sandbox.browser.cdpSourceRange` 时，它也会发出警告。
它还会标记危险的沙盒 Docker 网络模式（包括 `host` 和 `container:*` 命名空间连接）。
当现有的沙盒浏览器 Docker 容器缺少/过时的哈希标签（例如缺少 `openclaw.browserConfigEpoch` 的迁移前容器）时，它也会发出警告，并推荐 `openclaw sandbox recreate --browser --all`。
当基于 npm 的插件/钩子安装记录未固定、缺少完整性元数据或与当前安装的包版本不一致时，它也会发出警告。
当频道允许列表依赖可变名称/电子邮件/标签而不是稳定 ID 时（Discord、Slack、Google Chat、Microsoft Teams、Mattermost、IRC 范围，如适用），它会发出警告。
当 `gateway.auth.mode="none"` 使网关 HTTP API 在没有共享密钥的情况下可访问时（`/tools/invoke` 加上任何启用的 `/v1/*` 端点），它会发出警告。
以 `dangerous`/`dangerously` 为前缀的设置是明确的紧急操作员覆盖；启用一个本身不是安全漏洞报告。
有关完整的危险参数清单，请参阅 [安全](/gateway/security) 中的"不安全或危险标志摘要"部分。

SecretRef 行为：

- `security audit` 在只读模式下解析其目标路径中支持的 SecretRef。
- 如果 SecretRef 在当前命令路径中不可用，审计会继续并报告 `secretDiagnostics`（而不是崩溃）。
- `--token` 和 `--password` 仅覆盖该命令调用的深度探测认证；它们不会重写配置或 SecretRef 映射。

## JSON 输出

使用 `--json` 进行 CI/策略检查：

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

如果结合使用 `--fix` 和 `--json`，输出将包括修复操作和最终报告：

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## `--fix` 更改什么

`--fix` 应用安全、确定性的修复：

- 将常见的 `groupPolicy="open"` 切换为 `groupPolicy="allowlist"`（包括支持频道中的账户变体）
- 当 WhatsApp 群组策略切换到 `allowlist` 时，从存储的 `allowFrom` 文件中种子化 `groupAllowFrom`，当该列表存在且配置尚未定义 `allowFrom` 时
- 将 `logging.redactSensitive` 从 `"off"` 设置为 `"tools"`
- 收紧状态/配置和常见敏感文件的权限
  （`credentials/*.json`、`auth-profiles.json`、`sessions.json`、会话
  `*.jsonl`）
- 还收紧从 `openclaw.json` 引用的配置包含文件
- 在 POSIX 主机上使用 `chmod`，在 Windows 上使用 `icacls` 重置

`--fix` 不会：

- 轮换令牌/密码/API 密钥
- 禁用工具（`gateway`、`cron`、`exec` 等）
- 更改网关绑定/认证/网络暴露选择
- 删除或重写插件/技能