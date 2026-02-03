---
read_when:
  - 排查运行时问题或故障时
summary: 常见 OpenClaw 故障的快速解决问题指南
title: 故障排除
x-i18n:
  generated_at: "2026-02-01T21:08:01Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a07bb06f0b5ef56872578aaff6ac83adb740e2f1d23e3eed86934b51f62a877e
  source_path: gateway/troubleshooting.md
  workflow: 14
---

# 故障排除 🔧

当 OpenClaw 出现异常时，以下是修复方法。

如果你只想快速分诊，请先查看常见问题的[前 60 秒](/help/faq#first-60-seconds-if-somethings-broken)。本页将深入介绍运行时故障和诊断方法。

提供商相关快捷入口：[/channels/troubleshooting](/channels/troubleshooting)

## 状态与诊断

快速分诊命令（按顺序执行）：

| 命令                               | 告诉你什么                                                                           | 何时使用                         |
| ---------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `openclaw status`                  | 本地摘要：操作系统 + 更新、Gateway网关可达性/模式、服务、智能体/会话、提供商配置状态 | 首次检查，快速概览               |
| `openclaw status --all`            | 完整本地诊断（只读、可粘贴、基本安全）包含日志尾部                                   | 需要分享调试报告时               |
| `openclaw status --deep`           | 运行 Gateway网关健康检查（包括提供商探测；需要 Gateway网关可达）                     | 当"已配置"不等于"正常工作"时     |
| `openclaw gateway probe`           | Gateway网关发现 + 可达性（本地 + 远程目标）                                          | 怀疑探测了错误的 Gateway网关时   |
| `openclaw channels status --probe` | 向运行中的 Gateway网关查询渠道状态（可选探测）                                       | Gateway网关可达但渠道异常时      |
| `openclaw gateway status`          | 管理器状态（launchd/systemd/schtasks）、运行时 PID/退出码、最后一次 Gateway网关错误  | 服务"看起来已加载"但实际未运行时 |
| `openclaw logs --follow`           | 实时日志（运行时问题的最佳信号源）                                                   | 需要查看实际失败原因时           |

**分享输出：** 优先使用 `openclaw status --all`（它会脱敏令牌）。如果粘贴 `openclaw status` 的输出，建议先设置 `OPENCLAW_SHOW_SECRETS=0`（令牌预览）。

另见：[健康检查](/gateway/health) 和 [日志](/logging)。

## 常见问题

### No API key found for provider "anthropic"

这意味着**智能体的认证存储为空**或缺少 Anthropic 凭据。
认证是**按智能体隔离的**，因此新智能体不会继承主智能体的密钥。

修复选项：

- 重新运行新手引导，为该智能体选择 **Anthropic**。
- 或者在 **Gateway网关主机**上粘贴 setup-token：
  ```bash
  openclaw models auth setup-token --provider anthropic
  ```
- 或将主智能体目录中的 `auth-profiles.json` 复制到新智能体目录。

验证：

```bash
openclaw models status
```

### OAuth token refresh failed (Anthropic Claude subscription)

这意味着存储的 Anthropic OAuth 令牌已过期且刷新失败。
如果你使用的是 Claude 订阅（无 API 密钥），最可靠的修复方法是
切换到 **Claude Code setup-token** 并在 **Gateway网关主机**上粘贴。

**推荐方式（setup-token）：**

```bash
# 在 Gateway网关主机上运行（粘贴 setup-token）
openclaw models auth setup-token --provider anthropic
openclaw models status
```

如果你在其他地方生成了令牌：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

更多详情：[Anthropic](/providers/anthropic) 和 [OAuth](/concepts/oauth)。

### 控制面板在 HTTP 下失败（"device identity required" / "connect failed"）

如果你通过纯 HTTP 打开仪表盘（例如 `http://<lan-ip>:18789/` 或
`http://<tailscale-ip>:18789/`），浏览器运行在**非安全上下文**中，
会阻止 WebCrypto，导致无法生成设备身份。

**修复：**

- 优先通过 [Tailscale Serve](/gateway/tailscale) 使用 HTTPS。
- 或在 Gateway网关主机上本地打开：`http://127.0.0.1:18789/`。
- 如果必须使用 HTTP，启用 `gateway.controlUi.allowInsecureAuth: true` 并
  使用 Gateway网关令牌（仅令牌；无设备身份/配对）。参见
  [控制面板](/web/control-ui#insecure-http)。

### CI 密钥扫描失败

这意味着 `detect-secrets` 发现了尚未纳入基线的新候选项。
请参考[密钥扫描](/gateway/security#secret-scanning-detect-secrets)。

### 服务已安装但未运行

如果 Gateway网关服务已安装但进程立即退出，服务
可能显示"已加载"但实际上没有任何进程在运行。

**检查：**

```bash
openclaw gateway status
openclaw doctor
```

Doctor/service 会显示运行时状态（PID/上次退出码）和日志提示。

**日志：**

- 推荐：`openclaw logs --follow`
- 文件日志（始终可用）：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（或你配置的 `logging.file`）
- macOS LaunchAgent（如已安装）：`$OPENCLAW_STATE_DIR/logs/gateway.log` 和 `gateway.err.log`
- Linux systemd（如已安装）：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows：`schtasks /Query /TN "OpenClaw Gateway网关 (<profile>)" /V /FO LIST`

**启用更详细的日志：**

- 提高文件日志详细级别（持久化 JSONL）：
  ```json
  { "logging": { "level": "debug" } }
  ```
- 提高控制台日志详细级别（仅 TTY 输出）：
  ```json
  { "logging": { "consoleLevel": "debug", "consoleStyle": "pretty" } }
  ```
- 小提示：`--verbose` 仅影响**控制台**输出。文件日志仍由 `logging.level` 控制。

完整的格式、配置和访问概览请参见 [/logging](/logging)。

### "Gateway网关 start blocked: set gateway.mode=local"

这意味着配置文件存在但 `gateway.mode` 未设置（或不是 `local`），因此
Gateway网关拒绝启动。

**修复（推荐）：**

- 运行向导并将 Gateway网关运行模式设置为 **Local**：
  ```bash
  openclaw configure
  ```
- 或直接设置：
  ```bash
  openclaw config set gateway.mode local
  ```

**如果你打算运行远程 Gateway网关：**

- 设置远程 URL 并保持 `gateway.mode=remote`：
  ```bash
  openclaw config set gateway.mode remote
  openclaw config set gateway.remote.url "wss://gateway.example.com"
  ```

**仅限临时/开发用途：** 传递 `--allow-unconfigured` 以在未设置
`gateway.mode=local` 的情况下启动 Gateway网关。

**还没有配置文件？** 运行 `openclaw setup` 创建初始配置，然后重新运行
Gateway网关。

### 服务环境（PATH + 运行时）

Gateway网关服务运行时使用**最小化 PATH**，以避免 shell/管理器的干扰：

- macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
- Linux：`/usr/local/bin`、`/usr/bin`、`/bin`

这有意排除了版本管理器（nvm/fnm/volta/asdf）和包
管理器（pnpm/npm），因为服务不会加载你的 shell 初始化脚本。运行时
变量如 `DISPLAY` 应放在 `~/.openclaw/.env` 中（由 Gateway网关在启动早期加载）。
在 `host=gateway` 上的 Exec 运行会将你的登录 shell `PATH` 合并到执行环境中，
因此缺少工具通常意味着你的 shell 初始化脚本没有导出它们（或设置
`tools.exec.pathPrepend`）。参见 [/tools/exec](/tools/exec)。

WhatsApp + Telegram 渠道需要 **Node**；不支持 Bun。如果你的
服务安装时使用了 Bun 或版本管理器管理的 Node 路径，请运行 `openclaw doctor`
以迁移到系统级 Node 安装。

### Skills 在沙箱中缺少 API 密钥

**症状：** Skills 在主机上正常运行，但在沙箱中因缺少 API 密钥而失败。

**原因：** 沙箱隔离的 exec 在 Docker 中运行，**不会**继承主机的 `process.env`。

**修复：**

- 设置 `agents.defaults.sandbox.docker.env`（或按智能体设置 `agents.list[].sandbox.docker.env`）
- 或将密钥内置到自定义沙箱镜像中
- 然后运行 `openclaw sandbox recreate --agent <id>`（或 `--all`）

### 服务在运行但端口未监听

如果服务报告**正在运行**但 Gateway网关端口上没有监听，
Gateway网关很可能拒绝了绑定。

**此处"正在运行"的含义**

- `Runtime: running` 表示你的管理器（launchd/systemd/schtasks）认为进程是活跃的。
- `RPC probe` 表示 CLI 实际上能够连接到 Gateway网关 WebSocket 并调用 `status`。
- 始终以 `Probe target:` + `Config (service):` 作为"我们实际尝试了什么？"的依据。

**检查：**

- `gateway.mode` 对于 `openclaw gateway` 和服务必须为 `local`。
- 如果你设置了 `gateway.mode=remote`，**CLI 默认**使用远程 URL。服务可能仍在本地运行，但你的 CLI 可能在探测错误的位置。使用 `openclaw gateway status` 查看服务解析的端口 + 探测目标（或传递 `--url`）。
- `openclaw gateway status` 和 `openclaw doctor` 会在服务看起来正在运行但端口未打开时显示**最后一次 Gateway网关错误**日志。
- 非 local loopback 绑定（`lan`/`tailnet`/`custom`，或 local loopback 不可用时的 `auto`）需要认证：
  `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- `gateway.remote.token` 仅用于远程 CLI 调用；它**不会**启用本地认证。
- `gateway.token` 会被忽略；请使用 `gateway.auth.token`。

**如果 `openclaw gateway status` 显示配置不匹配**

- `Config (cli): ...` 和 `Config (service): ...` 通常应该一致。
- 如果不一致，几乎可以确定你在编辑一个配置而服务在运行另一个配置。
- 修复：从你希望服务使用的相同 `--profile` / `OPENCLAW_STATE_DIR` 重新运行 `openclaw gateway install --force`。

**如果 `openclaw gateway status` 报告服务配置问题**

- 管理器配置（launchd/systemd/schtasks）缺少当前默认值。
- 修复：运行 `openclaw doctor` 更新配置（或 `openclaw gateway install --force` 完整重写）。

**如果 `Last gateway error:` 提到 "refusing to bind … without auth"**

- 你将 `gateway.bind` 设置为非 local loopback 模式（`lan`/`tailnet`/`custom`，或 local loopback 不可用时的 `auto`）但未配置认证。
- 修复：设置 `gateway.auth.mode` + `gateway.auth.token`（或导出 `OPENCLAW_GATEWAY_TOKEN`）并重启服务。

**如果 `openclaw gateway status` 显示 `bind=tailnet` 但未找到 tailnet 接口**

- Gateway网关尝试绑定到 Tailscale IP（100.64.0.0/10）但主机上未检测到。
- 修复：在该机器上启动 Tailscale（或将 `gateway.bind` 改为 `loopback`/`lan`）。

**如果 `Probe note:` 显示探测使用 local loopback**

- 对于 `bind=lan` 这是预期行为：Gateway网关监听 `0.0.0.0`（所有接口），local loopback 在本地仍可连接。
- 对于远程客户端，请使用真实的 LAN IP（不是 `0.0.0.0`）加端口，并确保已配置认证。

### 地址已被占用（端口 18789）

这意味着某个进程已经在 Gateway网关端口上监听。

**检查：**

```bash
openclaw gateway status
```

它会显示监听者和可能的原因（Gateway网关已在运行、SSH 隧道）。
如果需要，停止服务或选择其他端口。

### 检测到多余的工作区文件夹

如果你从旧版本升级，磁盘上可能仍有 `~/openclaw`。
多个工作区目录可能导致认证或状态漂移的混乱，因为
只有一个工作区是活跃的。

**修复：** 保留一个活跃工作区，归档/删除其余的。参见
[智能体工作区](/concepts/agent-workspace#extra-workspace-folders)。

### 主聊天在沙箱工作区中运行

症状：`pwd` 或文件工具显示 `~/.openclaw/sandboxes/...`，但你
期望的是主机工作区。

**原因：** `agents.defaults.sandbox.mode: "non-main"` 基于 `session.mainKey`（默认 `"main"`）判断。
群组/渠道会话使用自己的键，因此被视为非主会话并
获得沙箱工作区。

**修复选项：**

- 如果你想让某个智能体使用主机工作区：设置 `agents.list[].sandbox.mode: "off"`。
- 如果你想在沙箱内访问主机工作区：为该智能体设置 `workspaceAccess: "rw"`。

### "Agent was aborted"

智能体在响应过程中被中断。

**原因：**

- 用户发送了 `stop`、`abort`、`esc`、`wait` 或 `exit`
- 超时
- 进程崩溃

**修复：** 只需发送另一条消息。会话会继续。

### "Agent failed before reply: Unknown model: anthropic/claude-haiku-3-5"

OpenClaw 有意拒绝**旧版/不安全的模型**（特别是那些更
容易受到提示注入攻击的模型）。如果你看到此错误，说明该模型名称
已不再支持。

**修复：**

- 为该提供商选择一个**最新**模型，并更新你的配置或模型别名。
- 如果不确定有哪些可用模型，运行 `openclaw models list` 或
  `openclaw models scan` 并选择一个受支持的模型。
- 检查 Gateway网关日志了解详细的失败原因。

另见：[模型 CLI](/cli/models) 和 [模型提供商](/concepts/model-providers)。

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

**检查 3：** 查看日志

```bash
openclaw logs --follow
# 或者快速过滤：
tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)" | grep "blocked\\|skip\\|unauthorized"
```

### 配对码未送达

如果 `dmPolicy` 为 `pairing`，未知发送者应收到一个验证码，其消息在批准前会被忽略。

**检查 1：** 是否已有待处理的请求？

```bash
openclaw pairing list <channel>
```

每个渠道默认最多 **3 个**待处理的 私信 配对请求。如果列表已满，新请求在有一个被批准或过期之前不会生成验证码。

**检查 2：** 请求是否已创建但未发送回复？

```bash
openclaw logs --follow | grep "pairing request"
```

**检查 3：** 确认该渠道的 `dmPolicy` 不是 `open`/`allowlist`。

### 图片 + 提及无法正常工作

已知问题：当你发送图片且**仅附带提及**（无其他文本）时，WhatsApp 有时不会包含提及元数据。

**解决方法：** 在提及时添加一些文本：

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

默认超时为 30 分钟。对于长时间任务：

```json
{
  "reply": {
    "timeoutSeconds": 3600 // 1 小时
  }
}
```

或使用 `process` 工具将长命令放到后台运行。

### WhatsApp 断开连接

```bash
# 检查本地状态（凭据、会话、排队事件）
openclaw status
# 探测运行中的 Gateway网关 + 渠道（WA 连接 + Telegram + Discord API）
openclaw status --deep

# 查看最近的连接事件
openclaw logs --limit 200 | grep "connection\\|disconnect\\|logout"
```

**修复：** 通常在 Gateway网关运行后会自动重连。如果卡住，重启 Gateway网关进程（无论你用什么方式管理），或手动运行并附带详细输出：

```bash
openclaw gateway --verbose
```

如果你已被登出/取消关联：

```bash
openclaw channels logout
trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/credentials" # 如果 logout 无法完全清除
openclaw channels login --verbose       # 重新扫描二维码
```

### 媒体发送失败

**检查 1：** 文件路径是否有效？

```bash
ls -la /path/to/your/image.jpg
```

**检查 2：** 是否过大？

- 图片：最大 6MB
- 音频/视频：最大 16MB
- 文档：最大 100MB

**检查 3：** 查看媒体日志

```bash
grep "media\\|fetch\\|download" "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)" | tail -20
```

### 内存使用过高

OpenClaw 将对话历史保存在内存中。

**修复：** 定期重启或设置会话限制：

```json
{
  "session": {
    "historyLimit": 100 // 保留的最大消息数
  }
}
```

## 常见故障排除

### "Gateway网关 won't start — configuration invalid"

OpenClaw 现在会在配置包含未知键、格式错误的值或无效类型时拒绝启动。
这是出于安全考虑的有意设计。

使用 Doctor 修复：

```bash
openclaw doctor
openclaw doctor --fix
```

说明：

- `openclaw doctor` 会报告每个无效条目。
- `openclaw doctor --fix` 会应用迁移/修复并重写配置。
- 诊断命令如 `openclaw logs`、`openclaw health`、`openclaw status`、`openclaw gateway status` 和 `openclaw gateway probe` 即使配置无效也能运行。

### "All models failed" — 我应该先检查什么？

- 正在使用的提供商是否存在**凭据**（认证配置文件 + 环境变量）。
- **模型路由**：确认 `agents.defaults.model.primary` 和回退模型是你能访问的模型。
- `/tmp/openclaw/…` 中的 **Gateway网关日志**查看具体的提供商错误。
- **模型状态**：使用 `/model status`（聊天中）或 `openclaw models status`（CLI）。

### 我用个人 WhatsApp 号码运行 — 为什么自聊行为异常？

启用自聊模式并将你自己的号码加入白名单：

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

### WhatsApp 将我登出了。如何重新认证？

重新运行登录命令并扫描二维码：

```bash
openclaw channels login
```

### `main` 分支构建错误 — 标准修复路径是什么？

1. `git pull origin main && pnpm install`
2. `openclaw doctor`
3. 查看 GitHub issues 或 Discord
4. 临时解决方案：回退到较旧的提交

### npm install 失败（allow-build-scripts / 缺少 tar 或 yargs）。怎么办？

如果你从源码运行，请使用仓库指定的包管理器：**pnpm**（推荐）。
仓库声明了 `packageManager: "pnpm@…"`。

典型恢复步骤：

```bash
git status   # 确保你在仓库根目录
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

原因：pnpm 是此仓库配置的包管理器。

### 如何在 git 安装和 npm 安装之间切换？

使用**官网安装脚本**并通过标志选择安装方式。它会
就地升级并重写 Gateway网关服务以指向新的安装。

切换**到 git 安装**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
```

切换**到 npm 全局安装**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

说明：

- git 流程仅在仓库干净时才会 rebase。请先提交或暂存更改。
- 切换后运行：
  ```bash
  openclaw doctor
  openclaw gateway restart
  ```

### Telegram 块式流不在工具调用之间拆分文本。为什么？

块式流仅发送**已完成的文本块**。你看到单条消息的常见原因：

- `agents.defaults.blockStreamingDefault` 仍为 `"off"`。
- `channels.telegram.blockStreaming` 设置为 `false`。
- `channels.telegram.streamMode` 为 `partial` 或 `block` **且草稿流处于活跃状态**
  （私聊 + 话题）。草稿流在此情况下会禁用块式流。
- 你的 `minChars` / coalesce 设置过高，导致块被合并。
- 模型输出了一个大型文本块（没有中途刷新点）。

修复清单：

1. 将块式流设置放在 `agents.defaults` 下，而不是根级别。
2. 如果你想要真正的多消息块式回复，设置 `channels.telegram.streamMode: "off"`。
3. 调试时使用较小的 chunk/coalesce 阈值。

参见[流式传输](/concepts/streaming)。

### Discord 在我的服务器中不回复，即使设置了 `requireMention: false`。为什么？

`requireMention` 仅在渠道通过白名单**之后**控制提及门控。
默认情况下 `channels.discord.groupPolicy` 为 **allowlist**，因此必须显式启用服务器。
如果你设置了 `channels.discord.guilds.<guildId>.channels`，则只允许列出的频道；省略它则允许服务器中的所有频道。

修复清单：

1. 设置 `channels.discord.groupPolicy: "open"` **或**添加服务器白名单条目（可选添加频道白名单）。
2. 在 `channels.discord.guilds.<guildId>.channels` 中使用**数字频道 ID**。
3. 将 `requireMention: false` 放在 `channels.discord.guilds` **下方**（全局或按频道）。
   顶层 `channels.discord.requireMention` 不是受支持的键。
4. 确保机器人拥有 **Message Content Intent** 和频道权限。
5. 运行 `openclaw channels status --probe` 获取审计提示。

文档：[Discord](/channels/discord)、[渠道故障排除](/channels/troubleshooting)。

### Cloud Code Assist API 错误：invalid tool schema (400)。怎么办？

这几乎总是**工具 schema 兼容性**问题。Cloud Code Assist
端点接受 JSON Schema 的严格子集。OpenClaw 在当前 `main` 中会清洗/规范化工具
schema，但此修复尚未包含在最新发布版中（截至
2026 年 1 月 13 日）。

修复清单：

1. **更新 OpenClaw**：
   - 如果你能从源码运行，拉取 `main` 并重启 Gateway网关。
   - 否则，等待包含 schema 清洗器的下一个版本。
2. 避免不受支持的关键字，如 `anyOf/oneOf/allOf`、`patternProperties`、
   `additionalProperties`、`minLength`、`maxLength`、`format` 等。
3. 如果你定义自定义工具，保持顶层 schema 为 `type: "object"`，带
   `properties` 和简单枚举。

参见[工具](/tools)和 [TypeBox schemas](/concepts/typebox)。

## macOS 特定问题

### 授予权限时应用崩溃（语音/麦克风）

如果应用在你点击隐私提示的"允许"时消失或显示"Abort trap 6"：

**修复 1：重置 TCC 缓存**

```bash
tccutil reset All bot.molt.mac.debug
```

**修复 2：强制使用新 Bundle ID**
如果重置无效，更改 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中的 `BUNDLE_ID`（例如添加 `.test` 后缀）并重新构建。这会强制 macOS 将其视为新应用。

### Gateway网关卡在"Starting..."

应用连接到端口 `18789` 上的本地 Gateway网关。如果一直卡住：

**修复 1：停止管理器（推荐）**
如果 Gateway网关由 launchd 管理，杀死 PID 只会让它重新启动。先停止管理器：

```bash
openclaw gateway status
openclaw gateway stop
# 或：launchctl bootout gui/$UID/bot.molt.gateway（替换为 bot.molt.<profile>；旧版 com.openclaw.* 仍可用）
```

**修复 2：端口被占用（查找监听者）**

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果是非托管进程，先尝试优雅停止，然后逐步升级：

```bash
kill -TERM <PID>
sleep 1
kill -9 <PID> # 最后手段
```

**修复 3：检查 CLI 安装**
确保全局 `openclaw` CLI 已安装且版本与应用匹配：

```bash
openclaw --version
npm install -g openclaw@<version>
```

## 调试模式

获取详细日志：

```bash
# 在配置中开启 trace 日志：
#   ${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json} -> { logging: { level: "trace" } }
#
# 然后运行 verbose 命令将调试输出镜像到标准输出：
openclaw gateway --verbose
openclaw channels login --verbose
```

## 日志位置

| 日志                          | 位置                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway网关文件日志（结构化） | `/tmp/openclaw/openclaw-YYYY-MM-DD.log`（或 `logging.file`）                                                                                                                                                                                                                                                                  |
| Gateway网关服务日志（管理器） | macOS：`$OPENCLAW_STATE_DIR/logs/gateway.log` + `gateway.err.log`（默认：`~/.openclaw/logs/...`；profile 使用 `~/.openclaw-<profile>/logs/...`）<br />Linux：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`<br />Windows：`schtasks /Query /TN "OpenClaw Gateway网关 (<profile>)" /V /FO LIST` |
| 会话文件                      | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                                                                                                                                                                                                                                                                              |
| 媒体缓存                      | `$OPENCLAW_STATE_DIR/media/`                                                                                                                                                                                                                                                                                                  |
| 凭据                          | `$OPENCLAW_STATE_DIR/credentials/`                                                                                                                                                                                                                                                                                            |

## 健康检查

```bash
# 管理器 + 探测目标 + 配置路径
openclaw gateway status
# 包含系统级扫描（旧版/多余服务、端口监听者）
openclaw gateway status --deep

# Gateway网关是否可达？
openclaw health --json
# 如果失败，附带连接详情重新运行：
openclaw health --verbose

# 默认端口上是否有监听？
lsof -nP -iTCP:18789 -sTCP:LISTEN

# 最近活动（RPC 日志尾部）
openclaw logs --follow
# RPC 不可用时的备选方案
tail -20 /tmp/openclaw/openclaw-*.log
```

## 重置一切

核弹选项：

```bash
openclaw gateway stop
# 如果你安装了服务并想全新安装：
# openclaw gateway uninstall

trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
openclaw channels login         # 重新配对 WhatsApp
openclaw gateway restart           # 或：openclaw gateway
```

⚠️ 这会丢失所有会话并需要重新配对 WhatsApp。

## 获取帮助

1. 先查看日志：`/tmp/openclaw/`（默认：`openclaw-YYYY-MM-DD.log`，或你配置的 `logging.file`）
2. 在 GitHub 上搜索现有 issues
3. 提交新 issue 并附上：
   - OpenClaw 版本
   - 相关日志片段
   - 复现步骤
   - 你的配置（脱敏！）

---

_"你试过关掉再打开吗？"_ — 每个 IT 人员都说过

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
