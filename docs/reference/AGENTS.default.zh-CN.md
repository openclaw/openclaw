---
title: "默认 AGENTS.md"
summary: "默认 OpenClaw 代理指令和技能名册（用于个人助手设置）"
read_when:
  - 开始新的 OpenClaw 代理会话
  - 启用或审核默认技能
---

# AGENTS.md - OpenClaw 个人助手（默认）

## 首次运行（推荐）

OpenClaw 为代理使用专用的工作区目录。默认：`~/.openclaw/workspace`（可通过 `agents.defaults.workspace` 配置）。

1. 创建工作区（如果它不存在）：

```bash
mkdir -p ~/.openclaw/workspace
```

2. 将默认工作区模板复制到工作区：

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 可选：如果你想要个人助手技能名册，请用此文件替换 AGENTS.md：

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 可选：通过设置 `agents.defaults.workspace` 选择不同的工作区（支持 `~`）：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 安全默认值

- 不要将目录或机密转储到聊天中。
- 除非明确要求，否则不要运行破坏性命令。
- 不要向外部消息传递界面发送部分/流式回复（仅发送最终回复）。

## 会话开始（必需）

- 读取 `SOUL.md`、`USER.md` 和 `memory/` 中的今天和昨天文件。
- 当存在 `MEMORY.md` 时读取；仅当 `MEMORY.md` 不存在时才回退到小写的 `memory.md`。
- 在回复前执行此操作。

## 灵魂（必需）

- `SOUL.md` 定义身份、语气和边界。保持其最新。
- 如果你更改 `SOUL.md`，请告诉用户。
- 每个会话你都是一个新实例；连续性存在于这些文件中。

## 共享空间（推荐）

- 你不是用户的声音；在群组聊天或公共频道中要小心。
- 不要共享私人数据、联系信息或内部笔记。

## 记忆系统（推荐）

- 每日日志：`memory/YYYY-MM-DD.md`（如需要，创建 `memory/` 文件夹）。
- 长期记忆：`MEMORY.md` 用于持久的事实、偏好和决定。
- 小写的 `memory.md` 仅用于旧版回退；不要故意同时保留两个根文件。
- 在会话开始时，读取今天、昨天和存在时的 `MEMORY.md`，否则读取 `memory.md`。
- 捕获：决定、偏好、约束、开放循环。
- 除非明确要求，否则避免机密。

## 工具和技能

- 工具存在于技能中；当你需要技能时，请遵循技能的 `SKILL.md`。
- 在 `TOOLS.md` 中保留环境特定的笔记（技能笔记）。

## 备份技巧（推荐）

如果你将此工作区视为 Clawd 的“记忆”，请将其设为 git 仓库（最好是私有的），这样 `AGENTS.md` 和你的记忆文件就会被备份。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# 可选：添加私有远程仓库 + 推送
```

## OpenClaw 做什么

- 运行 WhatsApp 网关 + Pi 编码代理，这样助手就可以通过主机 Mac 读取/写入聊天、获取上下文和运行技能。
- macOS 应用程序管理权限（屏幕录制、通知、麦克风），并通过其捆绑的二进制文件公开 `openclaw` CLI。
- 默认情况下，直接聊天会折叠到代理的 `main` 会话中；群组保持隔离为 `agent:<agentId>:<channel>:group:<id>`（房间/频道：`agent:<agentId>:<channel>:channel:<id>`）；心跳保持后台任务活跃。

## 核心技能（在设置 → 技能中启用）

- **mcporter** — 用于管理外部技能后端的工具服务器运行时/CLI。
- **Peekaboo** — 快速 macOS 屏幕截图，带有可选的 AI 视觉分析。
- **camsnap** — 从 RTSP/ONVIF 安全摄像头捕获帧、剪辑或运动警报。
- **oracle** — 具有会话重放和浏览器控制的 OpenAI 就绪代理 CLI。
- **eightctl** — 从终端控制你的睡眠。
- **imsg** — 发送、读取、流式传输 iMessage 和 SMS。
- **wacli** — WhatsApp CLI：同步、搜索、发送。
- **discord** — Discord 操作：反应、贴纸、投票。使用 `user:<id>` 或 `channel:<id>` 目标（裸数字 ID 是不明确的）。
- **gog** — Google Suite CLI：Gmail、日历、驱动器、联系人。
- **spotify-player** — 终端 Spotify 客户端，用于搜索/排队/控制播放。
- **sag** — ElevenLabs 语音，带有 mac 风格的 say UX；默认流式传输到扬声器。
- **Sonos CLI** — 从脚本控制 Sonos 扬声器（发现/状态/播放/音量/分组）。
- **blucli** — 从脚本播放、分组和自动化 BluOS 播放器。
- **OpenHue CLI** — 用于场景和自动化的 Philips Hue 灯光控制。
- **OpenAI Whisper** — 本地语音转文本，用于快速听写和语音邮件转录。
- **Gemini CLI** — 从终端快速问答的 Google Gemini 模型。
- **agent-tools** — 用于自动化和助手脚本的实用工具包。

## 使用说明

- 脚本编程首选 `openclaw` CLI；mac 应用程序处理权限。
- 从技能选项卡运行安装；如果二进制文件已存在，它会隐藏按钮。
- 保持心跳启用，以便助手可以安排提醒、监控收件箱并触发摄像头捕获。
- Canvas UI 全屏运行，带有本机覆盖。避免将关键控件放在左上角/右上角/底部边缘；在布局中添加明确的边距，不要依赖安全区域插页。
- 对于浏览器驱动的验证，使用带有 OpenClaw 管理的 Chrome 配置文件的 `openclaw browser`（选项卡/状态/截图）。
- 对于 DOM 检查，使用 `openclaw browser eval|query|dom|snapshot`（当你需要机器输出时使用 `--json`/`--out`）。
- 对于交互，使用 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`（点击/键入需要快照引用；对于 CSS 选择器使用 `evaluate`）。
