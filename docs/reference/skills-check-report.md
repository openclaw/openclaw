# 技能全局检查报告

本文档说明如何根据 `openclaw skills list --verbose` 的结果分类技能，以及**仅通过配置即可解决**的项（API Key / 环境变量 / 通道与插件配置）。

## 1. 当前状态汇总（基于最近一次 list）

| 分类 | 数量 | 说明 |
|------|------|------|
| **✓ ready** | 6 | 无需额外配置即可使用 |
| **仅缺 API Key / 环境变量** | 8 | 在 `openclaw.json` 或环境变量中配置后即可 |
| **仅缺通道/插件配置** | 4 | 在 Control UI 或 `openclaw config set` 中配置 |
| **仅缺 CLI（需安装第三方工具）** | 32 | 需自行安装对应 CLI，见下方列表 |
| **同时缺 env + bins** | 2 | 既需配置 Key 又需安装 CLI |

---

## 2. 已就绪技能（无需操作）

- `coding-agent` — 编码代理
- `healthcheck` — 安全与健康检查
- `session-logs` — 会话日志查询（jq）
- `skill-creator` — 技能创作
- `video-frames` — 视频抽帧（ffmpeg）
- `weather` — 天气（wttr.in / Open-Meteo，无需 API Key）

---

## 3. 仅缺 API Key / 环境变量（可配置解决）

以下技能只需在 **`~/.openclaw/openclaw.json`** 的 `skills.entries.<技能名>` 中填写 `apiKey` 或 `env`，或设置对应环境变量即可变为 eligible。

| 技能 | 需要的 Key/Env | 配置方式 |
|------|----------------|----------|
| **goplaces** | `GOOGLE_PLACES_API_KEY` | `skills.entries.goplaces.apiKey` 或环境变量；另需安装 CLI `goplaces` |
| **nano-banana-pro** | `GEMINI_API_KEY` | `skills.entries["nano-banana-pro"].apiKey` 或环境变量 |
| **notion** | `NOTION_API_KEY` | `skills.entries.notion.apiKey` 或环境变量 |
| **openai-image-gen** | `OPENAI_API_KEY` | `skills.entries["openai-image-gen"].apiKey` 或环境变量 |
| **openai-whisper-api** | `OPENAI_API_KEY` | 同上或 `skills.entries["openai-whisper-api"].apiKey` |
| **sag** | `ELEVENLABS_API_KEY` | `skills.entries.sag.apiKey` 或环境变量；另需安装 CLI `sag` |
| **sherpa-onnx-tts** | `SHERPA_ONNX_RUNTIME_DIR`, `SHERPA_ONNX_MODEL_DIR` | 在 `skills.entries["sherpa-onnx-tts"].env` 或环境变量中设置两个目录路径 |
| **trello** | `TRELLO_API_KEY`, `TRELLO_TOKEN` | 在 `skills.entries.trello.env` 中设置两个键，或使用环境变量 |

**说明**：若技能有 `primaryEnv`（如 xai 的 `XAI_API_KEY`），在 `skills.entries.<name>.apiKey` 中填写的值会在运行时注入到该环境变量，无需再单独设 env。

---

## 4. 仅缺通道/插件配置（非 skills.entries）

这些技能依赖 **通道** 或 **插件** 的配置，需在 **Control UI** 或 **`openclaw config set`** 中设置，而不是在 `skills.entries` 下。

| 技能 | 需要的配置路径 | 说明 |
|------|----------------|------|
| **bluebubbles** | `channels.bluebubbles` | 在 Control UI 中配置 BlueBubbles 通道（账号等） |
| **discord** | `channels.discord.token` | 配置 Discord Bot Token（或 `channels.discord.accounts.*.token`） |
| **slack** | `channels.slack` | 配置 Slack 的 botToken / appToken 等 |
| **voice-call** | `plugins.entries.voice-call.enabled` | 启用 voice-call 插件并配置 Twilio 等 |

配置示例（CLI）：

```bash
# Discord 仅示例：将 token 写入配置（敏感信息勿提交到仓库）
openclaw config set channels.discord.token "YOUR_BOT_TOKEN"

# 启用 voice-call 插件
openclaw config set plugins.entries.voice-call.enabled true
```

---

## 5. 仅缺 CLI（需安装第三方工具）

以下技能需要先安装对应命令行工具，安装后无需在 OpenClaw 中配置 Key 即可变为 eligible（除非表中另有 env 说明）。

| 技能 | 需要安装的 bin | 备注 |
|------|----------------|------|
| 1password | `op` | 1Password CLI |
| apple-notes | `memo` | [memo](https://github.com/antoniorodr/memo) |
| apple-reminders | `remindctl` | [remindctl](https://github.com/steipete/remindctl) |
| bear-notes | `grizzly` | Bear 笔记 CLI |
| blogwatcher | `blogwatcher` | RSS/Atom 监控 |
| blucli | `blu` | BluOS CLI |
| camsnap | `camsnap` | [camsnap.ai](https://camsnap.ai) |
| clawhub | `clawhub` | `npm i -g clawhub` |
| eightctl | `eightctl` | [eightctl.sh](https://eightctl.sh) |
| gemini | `gemini` | Google Gemini CLI |
| gh-issues / github | `gh` | GitHub CLI，需 `gh auth login` |
| gifgrep | `gifgrep` | [gifgrep.com](https://gifgrep.com) |
| himalaya | `himalaya` | 邮件 CLI |
| imsg | `imsg` | iMessage/SMS CLI（macOS） |
| mcporter | `mcporter` | MCP 客户端 |
| model-usage | `codexbar` | CodexBar 用量统计 |
| nano-pdf | `nano-pdf` | PDF 编辑 CLI |
| obsidian | `obsidian-cli` | Obsidian CLI |
| openai-whisper | `whisper` | 本地 Whisper CLI |
| openhue | `openhue` | Philips Hue |
| oracle | `oracle` | [askoracle.dev](https://askoracle.dev) |
| ordercli | `ordercli` | [ordercli.sh](https://ordercli.sh) |
| peekaboo | `peekaboo` | [peekaboo.boo](https://peekaboo.boo) |
| songsee | `songsee` | 音频谱图 |
| sonoscli | `sonos` | [sonoscli.sh](https://sonoscli.sh) |
| spotify-player | `spogo` 或 `spotify_player` | 二选一即可 |
| summarize | `summarize` | [summarize.sh](https://summarize.sh) |
| things-mac | `things` | Things 3 CLI |
| tmux | `tmux` | 系统常见已安装 |
| wacli | `wacli` | [wacli.sh](https://wacli.sh) |

---

## 6. 同时缺 env + bins 的技能

- **goplaces**：需 `GOOGLE_PLACES_API_KEY` + 安装 `goplaces` CLI。
- **sag**：需 `ELEVENLABS_API_KEY` + 安装 `sag` CLI。

配置好 Key 并安装对应 CLI 后，`openclaw skills list --eligible` 中会出现该技能。

---

## 7. 如何验证

- 查看所有技能及缺失项：`openclaw skills list --verbose`（避免使用 `-v`，会触发显示版本）。
- 仅查看已就绪技能：`openclaw skills list --eligible`。
- 检查单个技能：`openclaw skills info <技能名>`。

配置或安装完成后，再次运行 `openclaw skills list --eligible` 即可确认是否变为 ready。
