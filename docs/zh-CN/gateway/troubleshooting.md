---
read_when:
  - 调查运行时问题或故障
summary: OpenClaw 常见故障的快速故障排除指南
title: 故障排除
x-i18n:
  generated_at: "2026-02-03T10:09:42Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a07bb06f0b5ef56872578aaff6ac83adb740e2f1d23e3eed86934b51f62a877e
  source_path: gateway/troubleshooting.md
  workflow: 15
---

# 故障排除 🔧

当 OpenClaw 出现异常时，以下是解决方法。

如果你只想快速分类问题，请先查看常见问题的[最初的六十秒](/help/faq#first-60-seconds-if-somethings-broken)。本页深入介绍运行时故障和诊断。

特定提供商的快捷方式：[/channels/troubleshooting](/channels/troubleshooting)

## 状态与诊断

快速分类命令（按顺序）：

| 命令                               | 它告诉你什么                                                                          | 何时使用                              |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `openclaw status`                  | 本地摘要：操作系统 + 更新、Gateway 网关可达性/模式、服务、智能体/会话、提供商配置状态 | 首次检查，快速概览                    |
| `openclaw status --all`            | 完整本地诊断（只读、可粘贴、相对安全）包括日志尾部                                    | 当你需要分享调试报告时                |
| `openclaw status --deep`           | 运行 Gateway 网关健康检查（包括提供商探测；需要可达的 Gateway 网关）                  | 当"已配置"不意味着"正常工作"时        |
| `openclaw gateway probe`           | Gateway 网关发现 + 可达性（本地 + 远程目标）                                          | 当你怀疑正在探测错误的 Gateway 网关时 |
| `openclaw channels status --probe` | 向运行中的 Gateway 网关查询渠道状态（并可选探测）                                     | 当 Gateway 网关可达但渠道异常时       |
| `openclaw gateway status`          | 监管程序状态（launchd/systemd/schtasks）、运行时 PID/退出、最后的 Gateway 网关错误    | 当服务"看起来已加载"但没有运行时      |
| `openclaw logs --follow`           | 实时日志（运行时问题的最佳信号）                                                      | 当你需要实际的故障原因时              |

**分享输出：** 优先使用 `openclaw status --all`（它会隐藏令牌）。如果你粘贴 `openclaw status`，考虑先设置 `OPENCLAW_SHOW_SECRETS=0`（令牌预览）。

另请参阅：[健康检查](/gateway/health) 和 [日志](/logging)。

## 常见问题

### No API key found for provider "anthropic"

这意味着**智能体的认证存储为空**或缺少 Anthropic 凭证。
认证是**每个智能体独立的**，所以新智能体不会继承主智能体的密钥。

修复选项：

- 重新运行新手引导并为该智能体选择 **Anthropic**。
- 或在 **Gateway 网关主机**上粘贴 setup-token：
  ```bash
  openclaw models auth setup-token --provider anthropic
  ```
- 或将 `auth-profiles.json` 从主智能体目录复制到新智能体目录。

验证：

```bash
openclaw models status
```

### OAuth token refresh failed（Anthropic Claude 订阅）

这意味着存储的 Anthropic OAuth 令牌已过期且刷新失败。
如果你使用 Claude 订阅（无 API 密钥），最可靠的修复方法是
切换到 **Claude Code setup-token** 并在 **Gateway 网关主机**上粘贴。

**推荐（setup-token）：**

```bash
# 在 Gateway 网关主机上运行（粘贴 setup-token）
openclaw models auth setup-token --provider anthropic
openclaw models status
```

如果你在其他地方生成了令牌：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

更多详情：[Anthropic](/providers/anthropic) 和 [OAuth](/concepts/oauth)。

### Control UI 在 HTTP 上失败（"device identity required" / "connect failed"）

如果你通过纯 HTTP 打开仪表板（例如 `http://<lan-ip>:18789/` 或
`http://<tailscale-ip>:18789/`），浏览器运行在**非安全上下文**中，
会阻止 WebCrypto，因此无法生成设备身份。

**修复：**

- 优先通过 [Tailscale Serve](/gateway/tailscale) 使用 HTTPS。
- 或在 Gateway 网关主机上本地打开：`http://127.0.0.1:18789/`。
- 如果必须使用 HTTP，启用 `gateway.controlUi.allowInsecureAuth: true` 并
  使用 Gateway 网关令牌（仅令牌；无设备身份/配对）。参见
  [Control UI](/web/control-ui#insecure-http)。

### CI Secrets Scan Failed

这意味着 `detect-secrets` 发现了尚未在基线中的新候选项。
按照 [密钥扫描](/gateway/security#secret-scanning-detect-secrets) 操作。

### 服务已安装但没有运行

如果 Gateway 网关服务已安装但进程立即退出，服务
可能显示"已加载"但实际没有运行。

**检查：**

```bash
openclaw gateway status
openclaw doctor
```

Doctor/service 将显示运行时状态（PID/最后退出）和日志提示。

**日志：**

- 优先：`openclaw logs --follow`
- 文件日志（始终）：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（或你配置的 `logging.file`）
- macOS LaunchAgent（如果已安装）：`$OPENCLAW_STATE_DIR/logs/gateway.log` 和 `gateway.err.log`
- Linux systemd（如果已安装）：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows：`schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

**启用更多日志：**

- 提高文件日志详细程度（持久化 JSONL）：
  ```json
  { "logging": { "level": "debug" } }
  ```
- 提高控制台详细程度（仅 TTY 输出）：
  ```json
  { "logging": { "consoleLevel": "debug", "consoleStyle": "pretty" } }
  ```
- 快速提示：`--verbose` 仅影响**控制台**输出。文件日志仍由 `logging.level` 控制。

参见 [/logging](/logging) 了解格式、配置和访问的完整概述。

### "Gateway start blocked: set gateway.mode=local"

这意味着配置存在但 `gateway.mode` 未设置（或不是 `local`），所以
Gateway 网关拒绝启动。

**修复（推荐）：**

- 运行向导并将 Gateway 网关运行模式设置为 **Local**：
  ```bash
  openclaw configure
  ```
- 或直接设置：
  ```bash
  openclaw config set gateway.mode local
  ```

**如果你打算运行远程 Gateway 网关：**

- 设置远程 URL 并保持 `gateway.mode=remote`：
  ```bash
  openclaw config set gateway.mode remote
  openclaw config set gateway.remote.url "wss://gateway.example.com"
  ```

**仅临时/开发使用：** 传递 `--allow-unconfigured` 以在没有
`gateway.mode=local` 的情况下启动 Gateway 网关。

**还没有配置文件？** 运行 `openclaw setup` 创建初始配置，然后重新运行
Gateway 网关。

### 服务环境（PATH + 运行时）

Gateway 网关服务使用**最小 PATH** 运行以避免 shell/管理器的干扰：

- macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
- Linux：`/usr/local/bin`、`/usr/bin`、`/bin`

这有意排除版本管理器（nvm/fnm/volta/asdf）和包
管理器（pnpm/npm），因为服务不加载你的 shell 初始化。运行时
变量如 `DISPLAY` 应该放在 `~/.openclaw/.env` 中（由 Gateway 网关早期加载）。
在 `host=gateway` 上的 Exec 运行会将你的登录 shell `PATH` 合并到 exec 环境中，
所以缺少的工具通常意味着你的 shell 初始化没有导出它们（或设置
`tools.exec.pathPrepend`）。参见 [/tools/exec](/tools/exec)。

WhatsApp + Telegram 渠道需要 **Node**；不支持 Bun。如果你的
服务是用 Bun 或版本管理的 Node 路径安装的，运行 `openclaw doctor`
迁移到系统 Node 安装。

### 沙箱中 Skill 缺少 API 密钥

**症状：** Skill 在主机上工作但在沙箱中因缺少 API 密钥而失败。

**原因：** 沙箱 exec 在 Docker 内运行，**不**继承主机 `process.env`。

**修复：**

- 设置 `agents.defaults.sandbox.docker.env`（或每个智能体的 `agents.list[].sandbox.docker.env`）
- 或将密钥烘焙到你的自定义沙箱镜像中
- 然后运行 `openclaw sandbox recreate --agent <id>`（或 `--all`）

### 服务运行但端口未监听

如果服务报告**正在运行**但 Gateway 网关端口上没有监听，
Gateway 网关可能拒绝绑定。

**这里"正在运行"的含义**

- `Runtime: running` 意味着你的监管程序（launchd/systemd/schtasks）认为进程存活。
- `RPC probe` 意味着 CLI 实际上能够连接到 Gateway 网关 WebSocket 并调用 `status`。
- 始终信任 `Probe target:` + `Config (service):` 作为"我们实际尝试了什么？"的信息行。

**检查：**

- `gateway.mode` 必须为 `local` 才能运行 `openclaw gateway` 和服务。
- 如果你设置了 `gateway.mode=remote`，**CLI 默认**使用远程 URL。服务可能仍在本地运行，但你的 CLI 可能在探测错误的位置。使用 `openclaw gateway status` 查看服务解析的端口 + 探测目标（或传递 `--url`）。
- `openclaw gateway status` 和 `openclaw doctor` 在服务看起来正在运行但端口关闭时会显示日志中的**最后 Gateway 网关错误**。
- 非本地回环绑定（`lan`/`tailnet`/`custom`，或本地回环不可用时的 `auto`）需要认证：
  `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- `gateway.remote.token` 仅用于远程 CLI 调用；它**不**启用本地认证。
- `gateway.token` 被忽略；使用 `gateway.auth.token`。

**如果 `openclaw gateway status` 显示配置不匹配**

- `Config (cli): ...` 和 `Config (service): ...` 通常应该匹配。
- 如果不匹配，你几乎肯定是在编辑一个配置而服务运行的是另一个。
- 修复：从你希望服务使用的相同 `--profile` / `OPENCLAW_STATE_DIR` 重新运行 `openclaw gateway install --force`。

**如果 `openclaw gateway status` 报告服务配置问题**

- 监管程序配置（launchd/systemd/schtasks）缺少当前默认值。
- 修复：运行 `openclaw doctor` 更新它（或 `openclaw gateway install --force` 完全重写）。

**如果 `Last gateway error:` 提到"refusing to bind … without auth"**

- 你将 `gateway.bind` 设置为非本地回环模式（`lan`/`tailnet`/`custom`，或本地回环不可用时的 `auto`）但没有配置认证。
- 修复：设置 `gateway.auth.mode` + `gateway.auth.token`（或导出 `OPENCLAW_GATEWAY_TOKEN`）并重启服务。

**如果 `openclaw gateway status` 显示 `bind=tailnet` 但未找到 tailnet 接口**

- Gateway 网关尝试绑定到 Tailscale IP（100.64.0.0/10）但在主机上未检测到。
- 修复：在该机器上启动 Tailscale（或将 `gateway.bind` 改为 `loopback`/`lan`）。

**如果 `Probe note:` 说探测使用本地回环**

- 对于 `bind=lan` 这是预期的：Gateway 网关监听 `0.0.0.0`（所有接口），本地回环仍应本地连接。
- 对于远程客户端，使用真实的 LAN IP（不是 `0.0.0.0`）加端口，并确保配置了认证。

### 地址已被使用（端口 18789）

这意味着某些东西已经在 Gateway 网关端口上监听。

**检查：**

```bash
openclaw gateway status
```

它将显示监听器和可能的原因（Gateway 网关已在运行、SSH 隧道）。
如果需要，停止服务或选择不同的端口。

### 检测到额外的工作区文件夹

如果你从旧版本升级，你的磁盘上可能仍有 `~/openclaw`。
多个工作区目录可能导致令人困惑的认证或状态漂移，因为
只有一个工作区是活动的。

**修复：** 保留单个活动工作区并归档/删除其余的。参见
[智能体工作区](/concepts/agent-workspace#extra-workspace-folders)。

### 主聊天在沙箱工作区中运行

症状：`pwd` 或文件工具显示 `~/.openclaw/sandboxes/...` 即使你
期望的是主机工作区。

**原因：** `agents.defaults.sandbox.mode: "non-main"` 基于 `session.mainKey`（默认 `"main"`）判断。
群组/渠道会话使用它们自己的键，所以它们被视为非主会话并
获得沙箱工作区。

**修复选项：**

- 如果你想为智能体使用主机工作区：设置 `agents.list[].sandbox.mode: "off"`。
- 如果你想在沙箱内访问主机工作区：为该智能体设置 `workspaceAccess: "rw"`。

### "Agent was aborted"

智能体在响应中途被中断。

**原因：**

- 用户发送了 `stop`、`abort`、`esc`、`wait` 或 `exit`
- 超时超限
- 进程崩溃

**修复：** 只需发送另一条消息。会话将继续。

### "Agent failed before reply: Unknown model: anthropic/claude-haiku-3-5"

OpenClaw 有意拒绝**较旧/不安全的模型**（尤其是那些更容易受到提示词注入攻击的模型）。如果你看到此错误，该模型名称已不再支持。

**修复：**

- 为提供商选择**最新**模型并更新你的配置或模型别名。
- 如果你不确定哪些模型可用，运行 `openclaw models list` 或
  `openclaw models scan` 并选择一个支持的模型。
- 检查 Gateway 网关日志以获取详细的失败原因。

另请参阅：[模型 CLI](/cli/models) 和 [模型提供商](/concepts/model-providers)。

### 消息未触发

**检查 1：** 发送者是否在白名单中？

```bash
openclaw status
```

在输出中查找 `AllowFrom: ...`。

**检查 2：** 对于群聊，是否需要提及？

```bash
# 消息必须匹配 mentionPatterns 或显式提及；默认值在渠道 groups/guilds 中。
# 多智能体：`agents.list[].groupChat.mentionPatterns` 覆盖全局模式。
grep -n "agents\\|groupChat\\|mentionPatterns\\|channels\\.whatsapp\\.groups\\|channels\\.telegram\\.groups\\|channels\\.imessage\\.groups\\|channels\\.discord\\.guilds" \
  "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
```

**检查 3：** 检查日志

```bash
openclaw logs --follow
# 或者如果你想快速过滤：
tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)" | grep "blocked\\|skip\\|unauthorized"
```

### 配对码未到达

如果 `dmPolicy` 是 `pairing`，未知发送者应该收到一个代码，他们的消息在批准前会被忽略。

**检查 1：** 是否已有待处理的请求在等待？

```bash
openclaw pairing list <channel>
```

待处理的私信配对请求默认每个渠道上限为 **3 个**。如果列表已满，新请求将不会生成代码，直到一个被批准或过期。

**检查 2：** 请求是否已创建但未发送回复？

```bash
openclaw logs --follow | grep "pairing request"
```

**检查 3：** 确认该渠道的 `dmPolicy` 不是 `open`/`allowlist`。

### 图片 + 提及不工作

已知问题：当你发送只有提及的图片（没有其他文字）时，WhatsApp 有时不包含提及元数据。

**变通方法：** 在提及时添加一些文字：

- ❌ `@openclaw` + 图片
- ✅ `@openclaw check this` + 图片

### 会话未恢复

**检查 1：** 会话文件是否存在？

```bash
ls -la ~/.openclaw/agents/<agentId>/sessions/
```

**检查 2：** 重置窗口是否太短？

```json
{
  "session": {
    "reset": {
      "mode": "daily",
      "atHour": 4,
      "idleMinutes": 10080 // 7 天
    }
  }
}
```

**检查 3：** 是否有人发送了 `/new`、`/reset` 或重置触发器？

### 智能体超时

默认超时是 30 分钟。对于长任务：

```json
{
  "reply": {
    "timeoutSeconds": 3600 // 1 小时
  }
}
```

或使用 `process` 工具在后台运行长命令。

### WhatsApp 断开连接

```bash
# 检查本地状态（凭证、会话、排队事件）
openclaw status
# 探测运行中的 Gateway 网关 + 渠道（WA 连接 + Telegram + Discord API）
openclaw status --deep

# 查看最近的连接事件
openclaw logs --limit 200 | grep "connection\\|disconnect\\|logout"
```

**修复：** 通常在 Gateway 网关运行后会自动重连。如果卡住，重启 Gateway 网关进程（无论你如何监管它），或使用详细输出手动运行：

```bash
openclaw gateway --verbose
```

如果你已登出/取消关联：

```bash
openclaw channels logout
trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/credentials" # 如果 logout 无法完全清除所有内容
openclaw channels login --verbose       # 重新扫描二维码
```

### 媒体发送失败

**检查 1：** 文件路径是否有效？

```bash
ls -la /path/to/your/image.jpg
```

**检查 2：** 是否太大？

- 图片：最大 6MB
- 音频/视频：最大 16MB
- 文档：最大 100MB

**检查 3：** 检查媒体日志

```bash
grep "media\\|fetch\\|download" "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)" | tail -20
```

### 高内存使用

OpenClaw 在内存中保留对话历史。

**修复：** 定期重启或设置会话限制：

```json
{
  "session": {
    "historyLimit": 100 // 保留的最大消息数
  }
}
```

## 常见故障排除

### "Gateway won't start — configuration invalid"

当配置包含未知键、格式错误的值或无效类型时，OpenClaw 现在拒绝启动。
这是为了安全而故意设计的。

用 Doctor 修复：

```bash
openclaw doctor
openclaw doctor --fix
```

注意事项：

- `openclaw doctor` 报告每个无效条目。
- `openclaw doctor --fix` 应用迁移/修复并重写配置。
- 诊断命令如 `openclaw logs`、`openclaw health`、`openclaw status`、`openclaw gateway status` 和 `openclaw gateway probe` 即使配置无效也能运行。

### "All models failed" — 我应该首先检查什么？

- **凭证**存在于正在尝试的提供商（认证配置文件 + 环境变量）。
- **模型路由**：确认 `agents.defaults.model.primary` 和回退是你可以访问的模型。
- `/tmp/openclaw/…` 中的 **Gateway 网关日志**以获取确切的提供商错误。
- **模型状态**：使用 `/model status`（聊天）或 `openclaw models status`（CLI）。

### 我在我的个人 WhatsApp 号码上运行 — 为什么自聊天很奇怪？

启用自聊天模式并将你自己的号码加入白名单：

```json5
{
  channels: {
    whatsapp: {
      selfChatMode: true,
      dmPolicy: "allowlist",
      allowFrom: ["+15555550123"],
    },
  },
}
```

参见 [WhatsApp 设置](/channels/whatsapp)。

### WhatsApp 将我登出。如何重新认证？

再次运行登录命令并扫描二维码：

```bash
openclaw channels login
```

### `main` 上的构建错误 — 标准修复路径是什么？

1. `git pull origin main && pnpm install`
2. `openclaw doctor`
3. 检查 GitHub issues 或 Discord
4. 临时变通方法：检出较旧的提交

### npm install 失败（allow-build-scripts / 缺少 tar 或 yargs）。现在怎么办？

如果你从源代码运行，使用仓库的包管理器：**pnpm**（首选）。
仓库声明了 `packageManager: "pnpm@…"`。

典型恢复：

```bash
git status   # 确保你在仓库根目录
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

原因：pnpm 是此仓库配置的包管理器。

### 如何在 git 安装和 npm 安装之间切换？

使用**网站安装程序**并通过标志选择安装方法。它
原地升级并重写 Gateway 网关服务以指向新安装。

切换**到 git 安装**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
```

切换**到 npm 全局**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注意事项：

- git 流程仅在仓库干净时才 rebase。先提交或 stash 更改。
- 切换后，运行：
  ```bash
  openclaw doctor
  openclaw gateway restart
  ```

### Telegram 分块流式传输没有在工具调用之间分割文本。为什么？

分块流式传输只发送**已完成的文本块**。你看到单条消息的常见原因：

- `agents.defaults.blockStreamingDefault` 仍然是 `"off"`。
- `channels.telegram.blockStreaming` 设置为 `false`。
- `channels.telegram.streamMode` 是 `partial` 或 `block` **且草稿流式传输处于活动状态**
  （私聊 + 话题）。在这种情况下，草稿流式传输会禁用分块流式传输。
- 你的 `minChars` / coalesce 设置太高，所以块被合并了。
- 模型发出一个大的文本块（没有中间回复刷新点）。

修复清单：

1. 将分块流式传输设置放在 `agents.defaults` 下，而不是根目录。
2. 如果你想要真正的多消息分块回复，设置 `channels.telegram.streamMode: "off"`。
3. 调试时使用较小的 chunk/coalesce 阈值。

参见 [流式传输](/concepts/streaming)。

### 即使设置了 `requireMention: false`，Discord 也不在我的服务器中回复。为什么？

`requireMention` 只控制渠道通过白名单**之后**的提及门控。
默认情况下 `channels.discord.groupPolicy` 是 **allowlist**，所以必须显式启用 guild。
如果你设置了 `channels.discord.guilds.<guildId>.channels`，只允许列出的频道；省略它以允许 guild 中的所有频道。

修复清单：

1. 设置 `channels.discord.groupPolicy: "open"` **或**添加 guild 白名单条目（并可选添加频道白名单）。
2. 在 `channels.discord.guilds.<guildId>.channels` 中使用**数字频道 ID**。
3. 将 `requireMention: false` 放在 `channels.discord.guilds` **下面**（全局或每个频道）。
   顶级 `channels.discord.requireMention` 不是支持的键。
4. 确保机器人有 **Message Content Intent** 和频道权限。
5. 运行 `openclaw channels status --probe` 获取审计提示。

文档：[Discord](/channels/discord)、[渠道故障排除](/channels/troubleshooting)。

### Cloud Code Assist API 错误：invalid tool schema（400）。现在怎么办？

这几乎总是**工具模式兼容性**问题。Cloud Code Assist
端点接受 JSON Schema 的严格子集。OpenClaw 在当前 `main` 中清理/规范化工具
模式，但修复尚未包含在最后一个版本中（截至
2026 年 1 月 13 日）。

修复清单：

1. **更新 OpenClaw**：
   - 如果你可以从源代码运行，拉取 `main` 并重启 Gateway 网关。
   - 否则，等待包含模式清理器的下一个版本。
2. 避免不支持的关键字如 `anyOf/oneOf/allOf`、`patternProperties`、
   `additionalProperties`、`minLength`、`maxLength`、`format` 等。
3. 如果你定义自定义工具，保持顶级模式为 `type: "object"` 并使用
   `properties` 和简单枚举。

参见 [工具](/tools) 和 [TypeBox 模式](/concepts/typebox)。

## macOS 特定问题

### 授予权限（语音/麦克风）时应用崩溃

如果在你点击隐私提示的"允许"时应用消失或显示"Abort trap 6"：

**修复 1：重置 TCC 缓存**

```bash
tccutil reset All bot.molt.mac.debug
```

**修复 2：强制使用新的 Bundle ID**
如果重置不起作用，在 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中更改 `BUNDLE_ID`（例如，添加 `.test` 后缀）并重新构建。这会强制 macOS 将其视为新应用。

### Gateway 网关卡在"Starting..."

应用连接到端口 `18789` 上的本地 Gateway 网关。如果一直卡住：

**修复 1：停止监管程序（首选）**
如果 Gateway 网关由 launchd 监管，杀死 PID 只会重新生成它。先停止监管程序：

```bash
openclaw gateway status
openclaw gateway stop
# 或：launchctl bootout gui/$UID/bot.molt.gateway（用 bot.molt.<profile> 替换；旧版 com.openclaw.* 仍然有效）
```

**修复 2：端口被占用（查找监听器）**

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果是未被监管的进程，先尝试优雅停止，然后升级：

```bash
kill -TERM <PID>
sleep 1
kill -9 <PID> # 最后手段
```

**修复 3：检查 CLI 安装**
确保全局 `openclaw` CLI 已安装且与应用版本匹配：

```bash
openclaw --version
npm install -g openclaw@<version>
```

## 调试模式

获取详细日志：

```bash
# 在配置中打开跟踪日志：
#   ${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json} -> { logging: { level: "trace" } }
#
# 然后运行详细命令将调试输出镜像到标准输出：
openclaw gateway --verbose
openclaw channels login --verbose
```

## 日志位置

| 日志                             | 位置                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway 网关文件日志（结构化）   | `/tmp/openclaw/openclaw-YYYY-MM-DD.log`（或 `logging.file`）                                                                                                                                                                                                                                                              |
| Gateway 网关服务日志（监管程序） | macOS：`$OPENCLAW_STATE_DIR/logs/gateway.log` + `gateway.err.log`（默认：`~/.openclaw/logs/...`；配置文件使用 `~/.openclaw-<profile>/logs/...`）<br />Linux：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`<br />Windows：`schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST` |
| 会话文件                         | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                                                                                                                                                                                                                                                                          |
| 媒体缓存                         | `$OPENCLAW_STATE_DIR/media/`                                                                                                                                                                                                                                                                                              |
| 凭证                             | `$OPENCLAW_STATE_DIR/credentials/`                                                                                                                                                                                                                                                                                        |

## 健康检查

```bash
# 监管程序 + 探测目标 + 配置路径
openclaw gateway status
# 包括系统级扫描（旧版/额外服务、端口监听器）
openclaw gateway status --deep

# Gateway 网关是否可达？
openclaw health --json
# 如果失败，使用连接详情重新运行：
openclaw health --verbose

# 默认端口上是否有东西在监听？
lsof -nP -iTCP:18789 -sTCP:LISTEN

# 最近活动（RPC 日志尾部）
openclaw logs --follow
# 如果 RPC 宕机的备用方案
tail -20 /tmp/openclaw/openclaw-*.log
```

## 重置所有内容

核选项：

```bash
openclaw gateway stop
# 如果你安装了服务并想要干净安装：
# openclaw gateway uninstall

trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
openclaw channels login         # 重新配对 WhatsApp
openclaw gateway restart           # 或：openclaw gateway
```

⚠️ 这会丢失所有会话并需要重新配对 WhatsApp。

## 获取帮助

1. 首先检查日志：`/tmp/openclaw/`（默认：`openclaw-YYYY-MM-DD.log`，或你配置的 `logging.file`）
2. 在 GitHub 上搜索现有问题
3. 提交新问题时包含：
   - OpenClaw 版本
   - 相关日志片段
   - 重现步骤
   - 你的配置（隐藏密钥！）

---

_"你试过关掉再开吗？"_ — 每个 IT 人员都这么说

🦞🔧

### 浏览器无法启动（Linux）

如果你看到 `"Failed to start Chrome CDP on port 18800"`：

**最可能的原因：** Ubuntu 上的 Snap 打包的 Chromium。

**快速修复：** 改为安装 Google Chrome：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
```

然后在配置中设置：

```json
{
  "browser": {
    "executablePath": "/usr/bin/google-chrome-stable"
  }
}
```

**完整指南：** 参见 [browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
