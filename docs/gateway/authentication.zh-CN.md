---
summary: "模型认证：OAuth、API 密钥、Claude CLI 重用和 Anthropic 设置令牌"
read_when:
  - 调试模型认证或 OAuth 过期
  - 记录认证或凭据存储
title: "认证"
---

# 认证（模型提供商）

<Note>
本页面涵盖**模型提供商**认证（API 密钥、OAuth、Claude CLI 重用和 Anthropic 设置令牌）。有关**网关连接**认证（令牌、密码、受信任代理），请参阅 [配置](/gateway/configuration) 和 [受信任代理认证](/gateway/trusted-proxy-auth)。
</Note>

OpenClaw 支持模型提供商的 OAuth 和 API 密钥。对于始终开启的网关主机，API 密钥通常是最可预测的选择。当订阅/OAuth 流程与你的提供商账户模型匹配时，也支持这些流程。

有关完整的 OAuth 流程和存储布局，请参阅 [/concepts/oauth](/concepts/oauth)。
有关基于 SecretRef 的认证（`env`/`file`/`exec` 提供商），请参阅 [密钥管理](/gateway/secrets)。
有关 `models status --probe` 使用的凭据资格/原因代码规则，请参阅 [认证凭据语义](/auth-credential-semantics)。

## 推荐设置（API 密钥，任何提供商）

如果你运行长期网关，请为你选择的提供商开始使用 API 密钥。
对于 Anthropic 特别，API 密钥认证仍然是最可预测的服务器设置，但 OpenClaw 也支持重用本地 Claude CLI 登录。

1. 在你的提供商控制台中创建 API 密钥。
2. 将其放在**网关主机**（运行 `openclaw gateway` 的机器）上。

```bash
export <PROVIDER>_API_KEY="..."
openclaw models status
```

3. 如果网关在 systemd/launchd 下运行，建议将密钥放在 `~/.openclaw/.env` 中，以便守护进程可以读取它：

```bash
cat >> ~/.openclaw/.env <<'EOF'
<PROVIDER>_API_KEY=...
EOF
```

然后重启守护进程（或重启你的网关进程）并重新检查：

```bash
openclaw models status
openclaw doctor
```

如果你不想自己管理环境变量，初始化可以存储 API 密钥以供守护进程使用：`openclaw onboard`。

有关环境继承的详细信息（`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd），请参阅 [帮助](/help)。

## Anthropic：Claude CLI 和令牌兼容性

Anthropic 设置令牌认证在 OpenClaw 中仍然作为支持的令牌路径可用。Anthropic 工作人员后来告诉我们，OpenClaw 风格的 Claude CLI 使用再次被允许，因此 OpenClaw 将 Claude CLI 重用和 `claude -p` 使用视为对此集成的认可，除非 Anthropic 发布新政策。当主机上可用 Claude CLI 重用时，现在这是首选路径。

对于长期运行的网关主机，Anthropic API 密钥仍然是最可预测的设置。如果你想在同一主机上重用现有的 Claude 登录，请在初始化/配置中使用 Anthropic Claude CLI 路径。

手动令牌输入（任何提供商；写入 `auth-profiles.json` + 更新配置）：

```bash
openclaw models auth paste-token --provider openrouter
```

Auth 配置文件引用也支持静态凭据：

- `api_key` 凭据可以使用 `keyRef: { source, provider, id }`
- `token` 凭据可以使用 `tokenRef: { source, provider, id }`
- OAuth 模式配置文件不支持 SecretRef 凭据；如果 `auth.profiles.<id>.mode` 设置为 `"oauth"`，则该配置文件的 SecretRef 支持的 `keyRef`/`tokenRef` 输入将被拒绝。

自动化友好检查（过期/缺失时退出 `1`，即将过期时退出 `2`）：

```bash
openclaw models status --check
```

实时认证探测：

```bash
openclaw models status --probe
```

注意：

- 探测行可以来自认证配置文件、环境凭据或 `models.json`。
- 如果显式 `auth.order.<provider>` 省略了存储的配置文件，探测会为该配置文件报告 `excluded_by_auth_order`，而不是尝试它。
- 如果存在认证但 OpenClaw 无法为该提供商解析可探测的模型候选，探测会报告 `status: no_model`。
- 速率限制冷却可能是模型范围的。一个模型的冷却配置文件仍然可以用于同一提供商上的兄弟模型。

可选的操作脚本（systemd/Termux）在此处记录：
[认证监控脚本](/help/scripts#auth-monitoring-scripts)

## Anthropic 说明

Anthropic `claude-cli` 后端再次受到支持。

- Anthropic 工作人员告诉我们，这个 OpenClaw 集成路径再次被允许。
- 因此，OpenClaw 将 Claude CLI 重用和 `claude -p` 使用视为 Anthropic 支持的运行的认可，除非 Anthropic 发布新政策。
- Anthropic API 密钥仍然是长期网关主机和明确的服务器端计费控制的最可预测选择。

## 检查模型认证状态

```bash
openclaw models status
openclaw doctor
```

## API 密钥轮换行为（网关）

当 API 调用达到提供商速率限制时，一些提供商支持使用替代密钥重试请求。

- 优先级顺序：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（单个覆盖）
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Google 提供商还包括 `GOOGLE_API_KEY` 作为额外的回退。
- 同一个密钥列表在使用前会去重。
- OpenClaw 仅对速率限制错误（例如 `429`、`rate_limit`、`quota`、`resource exhausted`、`Too many concurrent requests`、`ThrottlingException`、`concurrency limit reached` 或 `workers_ai ... quota limit exceeded`）使用下一个密钥重试。
- 非速率限制错误不会使用备用密钥重试。
- 如果所有密钥都失败，将返回最后一次尝试的最终错误。

## 控制使用哪个凭据

### 每个会话（聊天命令）

使用 `/model <alias-or-id>@<profileId>` 为当前会话固定特定的提供商凭据（示例配置文件 ID：`anthropic:default`、`anthropic:work`）。

使用 `/model`（或 `/model list`）获取紧凑选择器；使用 `/model status` 获取完整视图（候选 + 下一个认证配置文件，以及配置时的提供商端点详细信息）。

### 每个代理（CLI 覆盖）

为代理设置显式的认证配置文件顺序覆盖（存储在该代理的 `auth-state.json` 中）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

使用 `--agent <id>` 目标特定代理；省略它以使用配置的默认代理。
当你调试顺序问题时，`openclaw models status --probe` 将省略的存储配置文件显示为 `excluded_by_auth_order`，而不是静默跳过它们。
当你调试冷却问题时，请记住速率限制冷却可能与一个模型 ID 相关联，而不是整个提供商配置文件。

## 故障排除

### "未找到凭据"

如果 Anthropic 配置文件缺失，请在**网关主机**上配置 Anthropic API 密钥或设置 Anthropic 设置令牌路径，然后重新检查：

```bash
openclaw models status
```

### 令牌即将过期/已过期

运行 `openclaw models status` 以确认哪个配置文件即将过期。如果 Anthropic 令牌配置文件缺失或过期，请通过设置令牌刷新该设置或迁移到 Anthropic API 密钥。