---
read_when:
  - 开始新的 OpenClaw 智能体会话
  - 启用或审查默认 Skills
summary: 默认 OpenClaw 智能体指令及个人助手设置的 Skills 清单
x-i18n:
  generated_at: "2026-02-01T21:36:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 20ec2b8d8fc03c16bbf0a75f011092e86382ca4182e8c0a4bc5f8ffd2be9c647
  source_path: reference/AGENTS.default.md
  workflow: 15
---

# AGENTS.md — OpenClaw 个人助手（默认）

## 首次运行（推荐）

OpenClaw 为智能体使用专用的工作区目录。默认路径：`~/.openclaw/workspace`（可通过 `agents.defaults.workspace` 配置）。

1. 创建工作区（如果尚不存在）：

```bash
mkdir -p ~/.openclaw/workspace
```

2. 将默认工作区模板复制到工作区：

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 可选：如果你需要个人助手 Skills 清单，请用此文件替换 AGENTS.md：

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 可选：通过设置 `agents.defaults.workspace` 选择不同的工作区（支持 `~`）：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 安全默认设置

- 不要将目录内容或密钥转储到聊天中。
- 除非被明确要求，不要执行破坏性命令。
- 不要向外部消息平台发送部分/流式回复（只发送最终回复）。

## 会话启动（必需）

- 读取 `SOUL.md`、`USER.md`、`memory.md`，以及 `memory/` 中今天和昨天的文件。
- 在回复之前完成上述操作。

## 灵魂文件（必需）

- `SOUL.md` 定义身份、语气和边界。保持其内容最新。
- 如果你修改了 `SOUL.md`，请告知用户。
- 每次会话你都是一个全新实例；连续性存储在这些文件中。

## 共享空间（推荐）

- 你不是用户的代言人；在群聊或公开渠道中请谨慎发言。
- 不要分享私人数据、联系信息或内部笔记。

## 记忆系统（推荐）

- 每日日志：`memory/YYYY-MM-DD.md`（如需要请创建 `memory/` 目录）。
- 长期记忆：`memory.md` 用于持久保存事实、偏好和决策。
- 会话启动时，读取今天 + 昨天的日志以及 `memory.md`（如果存在）。
- 记录：决策、偏好、约束条件、待处理事项。
- 除非被明确要求，避免记录密钥。

## 工具与 Skills

- 工具位于 Skills 中；需要时请遵循每个 Skills 的 `SKILL.md`。
- 将环境相关的备注保存在 `TOOLS.md`（Skills 备注）中。

## 备份提示（推荐）

如果你将此工作区视为 Clawd 的"记忆"，请将其设为 git 仓库（最好是私有的），以便备份 `AGENTS.md` 和记忆文件。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# 可选：添加私有远程仓库并推送
```

## OpenClaw 的功能

- 运行 WhatsApp Gateway网关 + Pi 编程智能体，使助手可以读写聊天、获取上下文，并通过宿主 Mac 运行 Skills。
- macOS 应用管理权限（屏幕录制、通知、麦克风），并通过其内置二进制文件提供 `openclaw` CLI。
- 直接聊天默认合并到智能体的 `main` 会话；群组保持隔离，格式为 `agent:<agentId>:<channel>:group:<id>`（房间/频道：`agent:<agentId>:<channel>:channel:<id>`）；心跳机制保持后台任务存活。

## 核心 Skills（在设置 → Skills 中启用）

- **mcporter** — 用于管理外部 Skills 后端的工具服务器运行时/CLI。
- **Peekaboo** — 支持可选 AI 视觉分析的快速 macOS 截图工具。
- **camsnap** — 从 RTSP/ONVIF 安防摄像头捕获帧、片段或运动警报。
- **oracle** — 支持会话回放和浏览器控制的 OpenAI 就绪智能体 CLI。
- **eightctl** — 从终端控制你的睡眠。
- **imsg** — 发送、读取、流式传输 iMessage 和短信。
- **wacli** — WhatsApp CLI：同步、搜索、发送。
- **discord** — Discord 操作：表情反应、贴纸、投票。使用 `user:<id>` 或 `channel:<id>` 目标（纯数字 ID 有歧义）。
- **gog** — Google Suite CLI：Gmail、日历、云端硬盘、通讯录。
- **spotify-player** — 终端 Spotify 客户端，用于搜索/排队/控制播放。
- **sag** — 具有 mac 风格 say 体验的 ElevenLabs 语音；默认流式输出到扬声器。
- **Sonos CLI** — 从脚本控制 Sonos 音箱（发现/状态/播放/音量/分组）。
- **blucli** — 从脚本播放、分组和自动化 BluOS 播放器。
- **OpenHue CLI** — Philips Hue 灯光控制，用于场景和自动化。
- **OpenAI Whisper** — 本地语音转文字，用于快速听写和语音邮件转录。
- **Gemini CLI** — 从终端使用 Google Gemini 模型进行快速问答。
- **bird** — X/Twitter CLI，无需浏览器即可发推、回复、阅读话题和搜索。
- **agent-tools** — 用于自动化和辅助脚本的实用工具包。

## 使用说明

- 脚本编写优先使用 `openclaw` CLI；mac 应用负责处理权限。
- 从 Skills 标签页运行安装；如果二进制文件已存在，安装按钮会自动隐藏。
- 保持心跳启用，以便助手可以安排提醒、监控收件箱和触发摄像头捕获。
- Canvas UI 以全屏方式运行并带有原生叠加层。避免将关键控件放置在左上/右上/底部边缘；在布局中添加明确的边距，不要依赖安全区域内边距。
- 对于浏览器驱动的验证，请使用 `openclaw browser`（tabs/status/screenshot），配合 OpenClaw 管理的 Chrome 配置文件。
- 对于 DOM 检查，请使用 `openclaw browser eval|query|dom|snapshot`（需要机器输出时使用 `--json`/`--out`）。
- 对于交互操作，请使用 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`（click/type 需要快照引用；使用 `evaluate` 进行 CSS 选择器操作）。
