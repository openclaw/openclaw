# OpenClaw Agent Tools 参考手册

> 本文档对 `src/agents/tools/` 下每个 Agent 工具的作用、输入参数和输出格式进行简要说明。
>
> **约定**：`必须` 列中 ✅ 表示必填，— 表示可选。

---

## 目录

| 工具名                                | 分类   | 简介                          |
| ------------------------------------- | ------ | ----------------------------- |
| [memory_search](#memory_search)       | 记忆   | 语义搜索记忆文件              |
| [memory_get](#memory_get)             | 记忆   | 按行读取记忆文件片段          |
| [web_search](#web_search)             | Web    | 联网搜索                      |
| [web_fetch](#web_fetch)               | Web    | 抓取网页内容                  |
| [image](#image)                       | 媒体   | 图像分析                      |
| [tts](#tts)                           | 媒体   | 文字转语音                    |
| [browser](#browser)                   | 浏览器 | 浏览器自动化控制              |
| [canvas](#canvas)                     | 界面   | 控制 Canvas 界面              |
| [message](#message)                   | 消息   | 跨渠道消息收发                |
| [cron](#cron)                         | 调度   | 管理定时任务                  |
| [nodes](#nodes)                       | 设备   | 控制配对节点（手机/PC）       |
| [session_status](#session_status)     | 会话   | 查看当前会话状态              |
| [sessions_list](#sessions_list)       | 会话   | 列出所有会话                  |
| [sessions_history](#sessions_history) | 会话   | 读取会话消息历史              |
| [sessions_send](#sessions_send)       | 会话   | 向另一个会话发消息            |
| [sessions_spawn](#sessions_spawn)     | 会话   | 创建子 Agent 会话             |
| [subagents](#subagents)               | 会话   | 管理已派生的子 Agent          |
| [agents_list](#agents_list)           | 会话   | 列出可用的 Agent              |
| [gateway](#gateway)                   | 系统   | 重启/配置 Gateway（仅 Owner） |

---

## memory_search

**作用**：在 `MEMORY.md` 和 `memory/*.md` 中进行语义搜索，召回与查询相关的记忆片段。这是回答涉及过去工作、决策、日期、人员偏好、待办事项等问题前的**必要步骤**。

**源文件**：`memory-tool.ts`

### 参数

| 参数         | 类型   | 必须 | 说明                      |
| ------------ | ------ | ---- | ------------------------- |
| `query`      | string | ✅   | 语义搜索查询文本          |
| `maxResults` | number | —    | 返回的最大结果数          |
| `minScore`   | number | —    | 最低相关性评分阈值（0–1） |

### 输出

```json
{
  "results": [
    { "path": "MEMORY.md", "snippet": "...", "startLine": 10, "endLine": 20, "citation": "..." }
  ],
  "provider": "openai",
  "model": "text-embedding-3-small"
}
```

失败时（记忆不可用）：`{ "results": [], "disabled": true, "unavailable": true, "error": "..." }`

---

## memory_get

**作用**：安全地读取记忆文件中的指定行范围，通常在 `memory_search` 找到位置后用来拉取具体内容，避免一次性加载整个文件。

**源文件**：`memory-tool.ts`

### 参数

| 参数    | 类型    | 必须 | 说明                            |
| ------- | ------- | ---- | ------------------------------- |
| `path`  | string  | ✅   | 相对于 agent 记忆目录的文件路径 |
| `from`  | integer | —    | 起始行号（1-based）             |
| `lines` | integer | —    | 读取的行数                      |

### 输出

```json
{ "path": "MEMORY.md", "text": "...", "from": 10, "lines": 5 }
```

---

## web_search

**作用**：调用联网搜索引擎（Brave / Perplexity / Grok / Kimi / Gemini），返回搜索结果或 AI 合成的答案与引用。实际使用的 provider 由网关配置决定。

**源文件**：`web-search.ts`

### 参数

| 参数          | 类型          | 必须 | 说明                                                                                 |
| ------------- | ------------- | ---- | ------------------------------------------------------------------------------------ |
| `query`       | string        | ✅   | 搜索关键词或问题                                                                     |
| `count`       | number (1–10) | —    | 返回结果数，默认 5                                                                   |
| `country`     | string        | —    | 2 字母国家代码，如 `US`、`DE`，默认 `US`                                             |
| `search_lang` | string        | —    | 搜索语言，2 字母 ISO 代码，如 `zh`、`en`                                             |
| `ui_lang`     | string        | —    | 界面语言，locale 格式，如 `zh-CN`、`en-US`                                           |
| `freshness`   | string        | —    | 时间过滤（`pd`=昨天 / `pw`=本周 / `pm`=本月 / `py`=今年 / `YYYY-MM-DDtoYYYY-MM-DD`） |

### 输出

- **Brave**：`{ results: [{ title, url, description, published, siteName }], tookMs, ... }`
- **AI 合成型**（Perplexity / Grok / Kimi / Gemini）：`{ content, citations: [...], model, tookMs, ... }`

---

## web_fetch

**作用**：拉取指定 URL 的网页内容并提取为 Markdown 或纯文本，适用于不需要浏览器交互的轻量页面访问。

**源文件**：`web-fetch.ts`

### 参数

| 参数          | 类型                     | 必须 | 说明                          |
| ------------- | ------------------------ | ---- | ----------------------------- |
| `url`         | string                   | ✅   | HTTP/HTTPS 目标 URL           |
| `extractMode` | `"markdown"` \| `"text"` | —    | 内容提取模式，默认 `markdown` |
| `maxChars`    | number (≥100)            | —    | 返回最大字符数，超出时截断    |

### 输出

```json
{
  "url": "https://...",
  "status": 200,
  "title": "页面标题",
  "text": "## 提取的正文内容...",
  "truncated": false,
  "length": 3200,
  "tookMs": 420
}
```

---

## image

**作用**：用视觉模型分析一张或多张图片，支持本地路径和 URL。**注意**：如果图片已经在用户消息中提供，模型可以直接看到，无需再调用此工具。

**源文件**：`image-tool.ts`

### 参数

| 参数         | 类型     | 必须 | 说明                                           |
| ------------ | -------- | ---- | ---------------------------------------------- |
| `image`      | string   | —    | 单张图片路径或 URL（与 `images` 至少提供一个） |
| `images`     | string[] | —    | 多张图片路径或 URL（最多 20 张）               |
| `prompt`     | string   | —    | 分析提示词，默认 `"Describe the image."`       |
| `model`      | string   | —    | 覆盖使用的图像模型                             |
| `maxBytesMb` | number   | —    | 图片加载大小上限（MB）                         |
| `maxImages`  | number   | —    | 最大图片数量，默认 20                          |

### 输出

```json
{
  "content": [{ "type": "text", "text": "图中显示了..." }],
  "details": { "model": "gpt-4o", "image": "/path/to/img.png" }
}
```

---

## tts

**作用**：文字转语音，音频会通过工具结果自动下发。成功调用后应回复 `{{SILENT_REPLY_TOKEN}}` 避免重复发送文字消息。

**源文件**：`tts-tool.ts`

### 参数

| 参数      | 类型   | 必须 | 说明                                               |
| --------- | ------ | ---- | -------------------------------------------------- |
| `text`    | string | ✅   | 要朗读的文本内容                                   |
| `channel` | string | —    | 目标 channel ID，影响音频输出格式（如 `telegram`） |

### 输出

```json
{
  "content": [{ "type": "text", "text": "[[audio_as_voice]]\nMEDIA:/tmp/tts-xxx.ogg" }],
  "details": { "audioPath": "/tmp/tts-xxx.ogg", "provider": "openai" }
}
```

---

## browser

**作用**：控制浏览器进行 UI 自动化，支持快照、截图、导航、点击、输入、拖拽等操作。

- `profile="chrome"` — 接管用户现有的 Chrome 标签页（需要先点击 Browser Relay 工具栏按钮）
- `profile="openclaw"` — 使用 OpenClaw 托管的独立浏览器实例

**源文件**：`browser-tool.ts`

### 参数（核心）

| 参数        | 类型                          | 必须 | 说明                                               |
| ----------- | ----------------------------- | ---- | -------------------------------------------------- |
| `action`    | enum（见下）                  | ✅   | 操作类型                                           |
| `profile`   | string                        | —    | 浏览器 profile：`chrome` 或 `openclaw`             |
| `target`    | `sandbox` \| `host` \| `node` | —    | 浏览器目标位置                                     |
| `targetUrl` | string                        | —    | `open` / `navigate` 时的目标 URL                   |
| `targetId`  | string                        | —    | 目标标签页 ID（snapshot 返回后传入保持上下文稳定） |
| `request`   | object                        | —    | `act` 操作的具体动作（见下）                       |
| `fullPage`  | boolean                       | —    | `screenshot` 时是否全页截图                        |
| `refs`      | `role` \| `aria`              | —    | `snapshot` ref 类型；`aria` 跨调用稳定             |

**action 枚举**：`status` / `start` / `stop` / `profiles` / `tabs` / `open` / `focus` / `close` / `snapshot` / `screenshot` / `navigate` / `console` / `pdf` / `upload` / `dialog` / `act`

**act request.kind 枚举**：`click` / `type` / `press` / `hover` / `drag` / `select` / `fill` / `resize` / `wait` / `evaluate` / `close`

### 输出

- `snapshot`：AI 格式的页面结构文本（含元素 ref 供后续操作使用）
- `screenshot`：图片文件
- `pdf`：`{ content: [{ "type": "text", "text": "FILE:/path/to.pdf" }] }`
- 其他操作：JSON 对象

---

## canvas

**作用**：控制节点上的 Canvas 界面，支持展示、隐藏、导航、执行 JS、截图，以及推送 A2UI 数据流。

**源文件**：`canvas-tool.ts`

### 参数

| 参数                           | 类型                                                                                     | 必须 | 说明                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ---- | ------------------------------------------- |
| `action`                       | `present` \| `hide` \| `navigate` \| `eval` \| `snapshot` \| `a2ui_push` \| `a2ui_reset` | ✅   | 操作类型                                    |
| `node`                         | string                                                                                   | —    | 目标节点 ID 或名称                          |
| `url`                          | string                                                                                   | —    | `present` / `navigate` 的目标 URL           |
| `javaScript`                   | string                                                                                   | —    | `eval` 时执行的 JS 代码（此 action 时必填） |
| `jsonl`                        | string                                                                                   | —    | `a2ui_push` 的 JSONL 字符串                 |
| `jsonlPath`                    | string                                                                                   | —    | `a2ui_push` 的 JSONL 文件路径               |
| `outputFormat`                 | `png` \| `jpg`                                                                           | —    | `snapshot` 输出格式，默认 `png`             |
| `maxWidth`                     | number                                                                                   | —    | `snapshot` 最大宽度                         |
| `x` / `y` / `width` / `height` | number                                                                                   | —    | `present` 时的窗口位置和尺寸                |

### 输出

- `present` / `hide` / `navigate` / `a2ui_*`：`{ ok: true }`
- `eval`：`{ content: [{ "type": "text", "text": "<JS 执行结果>" }] }`
- `snapshot`：图片（base64 + mimeType）

---

## message

**作用**：跨渠道收发消息，支持发送文字、媒体、Reaction、投票、Pin、Thread、删除等操作。可用的 action 由已配置的渠道插件动态决定（Telegram / Discord / Slack / WhatsApp / Signal / iMessage 等）。

**源文件**：`message-tool.ts`

### 参数（核心子集）

| 参数           | 类型         | 必须 | 说明                                                              |
| -------------- | ------------ | ---- | ----------------------------------------------------------------- |
| `action`       | enum（动态） | ✅   | 操作类型，如 `send`、`react`、`delete`、`pin` 等                  |
| `channel`      | string       | —    | 目标渠道 ID                                                       |
| `target`       | string       | —    | 发送目标（用户/频道 ID 或名称）                                   |
| `message`      | string       | —    | 消息文本内容                                                      |
| `media`        | string       | —    | 媒体文件路径或 URL                                                |
| `replyTo`      | string       | —    | 回复的消息 ID                                                     |
| `threadId`     | string       | —    | 线程 ID                                                           |
| `buttons`      | array[][]    | —    | Telegram 内联键盘按钮（行×列，含 `text`/`callback_data`/`style`） |
| `messageId`    | string       | —    | `react`/`delete` 的目标消息 ID                                    |
| `emoji`        | string       | —    | Reaction 表情                                                     |
| `pollQuestion` | string       | —    | 投票问题                                                          |
| `pollOption`   | string[]     | —    | 投票选项                                                          |
| `dryRun`       | boolean      | —    | 试运行，不实际发送                                                |

### 输出

由底层渠道插件决定，通常返回 `{ messageId, status, ... }` 等发送结果。

---

## cron

**作用**：管理 Gateway 的定时任务（Cron Job），支持查看、新增、修改、删除、手动触发以及发送唤醒事件。仅 Owner 可使用。

**源文件**：`cron-tool.ts`

### 参数

| 参数              | 类型                                                                             | 必须 | 说明                                                           |
| ----------------- | -------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `action`          | `status` \| `list` \| `add` \| `update` \| `remove` \| `run` \| `runs` \| `wake` | ✅   | 操作类型                                                       |
| `job`             | object                                                                           | —    | `add` 时的 job 定义（含 schedule / payload / delivery 等字段） |
| `jobId`           | string                                                                           | —    | `update`/`remove`/`run`/`runs` 时的 job ID                     |
| `patch`           | object                                                                           | —    | `update` 时要合并的字段                                        |
| `text`            | string                                                                           | —    | `wake` 时发送的消息文本（wake 时必填）                         |
| `mode`            | `now` \| `next-heartbeat`                                                        | —    | `wake` 模式，默认 `next-heartbeat`                             |
| `runMode`         | `due` \| `force`                                                                 | —    | `run` 模式，默认 `force`                                       |
| `includeDisabled` | boolean                                                                          | —    | `list` 时是否包含已禁用的 job                                  |
| `contextMessages` | number (0–10)                                                                    | —    | `add` 时附带的上下文消息数量                                   |

### 输出

- `status`：调度器状态
- `list`：job 列表数组
- `add` / `update`：操作后的 job 对象
- `remove`：删除结果
- `run`：触发结果
- `runs`：job 的历史运行记录
- `wake`：唤醒事件响应

---

## nodes

**作用**：发现并控制已配对的节点设备（手机/PC），支持拍照、录屏、位置、通知、命令执行、配对管理等操作。

**源文件**：`nodes-tool.ts`

### 参数（核心）

| 参数                      | 类型                        | 必须 | 说明                                     |
| ------------------------- | --------------------------- | ---- | ---------------------------------------- |
| `action`                  | enum（见下）                | ✅   | 操作类型                                 |
| `node`                    | string                      | —    | 目标节点 ID 或名称（大多数 action 必填） |
| `title` / `body`          | string                      | —    | `notify` 通知标题/正文                   |
| `facing`                  | `front` \| `back` \| `both` | —    | `camera_snap`/`camera_clip` 摄像头方向   |
| `duration` / `durationMs` | string / number             | —    | `camera_clip`/`screen_record` 时长       |
| `command`                 | string[]                    | —    | `run` 时的命令 argv 数组                 |
| `invokeCommand`           | string                      | —    | `invoke` 时的命令名                      |
| `requestId`               | string                      | —    | `approve`/`reject` 时的配对请求 ID       |

**action 枚举**：`status` / `describe` / `pending` / `approve` / `reject` / `notify` / `camera_snap` / `camera_list` / `camera_clip` / `screen_record` / `location_get` / `notifications_list` / `notifications_action` / `device_status` / `device_info` / `device_permissions` / `device_health` / `run` / `invoke`

### 输出

- `camera_snap`：图片文件（含 base64 预览）
- `camera_clip` / `screen_record`：`{ content: [{ "type": "text", "text": "FILE:/path/to.mp4" }] }`
- `notify`：`{ ok: true }`
- 其他：Gateway 返回的 JSON 对象

---

## session_status

**作用**：显示当前会话的状态卡片，包含模型、token 用量、费用、运行时间等信息。也可用于临时覆盖会话的模型（填 `"default"` 重置）。

**源文件**：`session-status-tool.ts`

### 参数

| 参数         | 类型   | 必须 | 说明                                        |
| ------------ | ------ | ---- | ------------------------------------------- |
| `sessionKey` | string | —    | 目标会话 key（默认为当前会话）              |
| `model`      | string | —    | 覆盖会话模型；填 `"default"` 重置为默认模型 |

### 输出

```json
{
  "content": [{ "type": "text", "text": "📊 Session Status\nModel: gpt-4o\n..." }],
  "details": { "ok": true, "sessionKey": "main", "changedModel": false }
}
```

---

## sessions_list

**作用**：列出 Gateway 上的所有会话，支持按类型、活跃时间过滤，并可附带每个会话的最近消息。

**源文件**：`sessions-list-tool.ts`

### 参数

| 参数            | 类型          | 必须 | 说明                                                                |
| --------------- | ------------- | ---- | ------------------------------------------------------------------- |
| `kinds`         | string[]      | —    | 过滤会话类型：`main` / `group` / `cron` / `hook` / `node` / `other` |
| `limit`         | number        | —    | 返回最大会话数                                                      |
| `activeMinutes` | number        | —    | 仅返回最近 N 分钟活跃的会话                                         |
| `messageLimit`  | number (0–20) | —    | 每个会话附带的最近消息条数                                          |

### 输出

```json
{
  "count": 5,
  "sessions": [
    { "key": "main", "kind": "main", "label": "...", "updatedAt": "...", "model": "gpt-4o", ... }
  ]
}
```

---

## sessions_history

**作用**：获取指定会话的消息历史，用于跨会话回顾对话内容。返回内容经过脱敏处理（密钥/token 被替换，图片 base64 被移除），总大小硬上限 80KB。

**源文件**：`sessions-history-tool.ts`

### 参数

| 参数           | 类型    | 必须 | 说明                             |
| -------------- | ------- | ---- | -------------------------------- |
| `sessionKey`   | string  | ✅   | 目标会话 key                     |
| `limit`        | number  | —    | 返回消息最大条数                 |
| `includeTools` | boolean | —    | 是否包含工具调用消息，默认 false |

### 输出

```json
{
  "sessionKey": "main",
  "messages": [{ "role": "user", "content": "..." }, ...],
  "truncated": false,
  "bytes": 12400
}
```

---

## sessions_send

**作用**：向另一个已有会话发送消息并等待回复（或以 fire-and-forget 方式投递）。用于多会话协同场景。

**源文件**：`sessions-send-tool.ts`

### 参数

| 参数             | 类型   | 必须 | 说明                                          |
| ---------------- | ------ | ---- | --------------------------------------------- |
| `message`        | string | ✅   | 要发送的消息内容                              |
| `sessionKey`     | string | —    | 目标会话 key（与 `label` 二选一）             |
| `label`          | string | —    | 目标会话 label                                |
| `agentId`        | string | —    | 目标 agent ID，与 `label` 配合使用            |
| `timeoutSeconds` | number | —    | 等待回复超时秒数；设为 0 表示 fire-and-forget |

### 输出

```json
{
  "runId": "...",
  "status": "ok",
  "reply": "Assistant 回复文本",
  "sessionKey": "other-session"
}
```

`status` 可为：`ok` / `accepted` / `timeout` / `error` / `forbidden`

---

## sessions_spawn

**作用**：派生一个独立的子 Agent 会话执行指定任务。支持一次性模式（`run`）和持久线程模式（`session`），可选择 subagent 或 ACP 运行时。

**源文件**：`sessions-spawn-tool.ts`

### 参数

| 参数                | 类型                | 必须 | 说明                                 |
| ------------------- | ------------------- | ---- | ------------------------------------ |
| `task`              | string              | ✅   | 要执行的任务描述                     |
| `runtime`           | `subagent` \| `acp` | —    | 运行时类型，默认 `subagent`          |
| `mode`              | `run` \| `session`  | —    | `run`=一次性执行，`session`=持久会话 |
| `label`             | string              | —    | 会话自定义标签                       |
| `agentId`           | string              | —    | 指定目标 agent ID                    |
| `model`             | string              | —    | 模型覆盖（仅 subagent）              |
| `thinking`          | string              | —    | 思考级别覆盖（仅 subagent）          |
| `cwd`               | string              | —    | 工作目录                             |
| `runTimeoutSeconds` | number              | —    | 运行超时秒数                         |
| `thread`            | boolean             | —    | 是否绑定到当前线程                   |
| `cleanup`           | `delete` \| `keep`  | —    | 完成后会话清理策略，默认 `keep`      |

### 输出

```json
{
  "sessionKey": "sub-xxx",
  "runId": "...",
  "status": "ok",
  "reply": "任务完成结果..."
}
```

---

## subagents

**作用**：列出、终止或转向当前 session 已派生的子 Agent。用于多 Agent 编排场景中的管控。

**源文件**：`subagents-tool.ts`

### 参数

| 参数            | 类型                        | 必须 | 说明                                                                                     |
| --------------- | --------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `action`        | `list` \| `kill` \| `steer` | —    | 操作类型，默认 `list`                                                                    |
| `target`        | string                      | —    | 目标子 agent（index / label / sessionKey / runId / `*` 表示全部）；`kill`/`steer` 时必填 |
| `message`       | string                      | —    | `steer` 时发给子 agent 的转向消息（最长 4000 字符）                                      |
| `recentMinutes` | number                      | —    | 活动时间窗口，默认 30 分钟，上限 1440                                                    |

### 输出

- **list**：`{ total, active: [...], recent: [...], text }` — 每项含 index/runId/label/task/status/runtimeMs/model 等
- **kill**：`{ status, killed, [cascadeKilled], text }`
- **steer**：`{ status, mode, label, text }`

---

## agents_list

**作用**：列出可通过 `sessions_spawn`（`runtime="subagent"`）调用的 Agent ID 列表。

**源文件**：`agents-list-tool.ts`

### 参数

无参数。

### 输出

```json
{
  "requester": "main-agent",
  "allowAny": false,
  "agents": [{ "id": "coding-agent", "name": "Coding Agent", "configured": true }]
}
```

---

## gateway

**作用**：重启 Gateway、读取/更新配置、触发 in-place 更新（SIGUSR1）。仅 Owner 可使用。

**源文件**：`gateway-tool.ts`

### 参数

| 参数             | 类型                                                                                             | 必须 | 说明                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------- |
| `action`         | `restart` \| `config.get` \| `config.schema` \| `config.apply` \| `config.patch` \| `update.run` | ✅   | 操作类型                                                 |
| `raw`            | string                                                                                           | —    | YAML/JSON 配置内容；`config.apply`/`config.patch` 时必填 |
| `note`           | string                                                                                           | —    | 重启后发给用户的说明消息（强烈建议填写）                 |
| `baseHash`       | string                                                                                           | —    | 当前配置 hash，用于防止冲突覆盖                          |
| `sessionKey`     | string                                                                                           | —    | 用于重启后路由回复的会话 key                             |
| `delayMs`        | number                                                                                           | —    | `restart` 时的延迟毫秒                                   |
| `reason`         | string                                                                                           | —    | `restart` 时的原因说明                                   |
| `restartDelayMs` | number                                                                                           | —    | `config.*`/`update.run` 写入后的重启延迟                 |

**action 说明**：

- `config.get` — 读取当前配置
- `config.schema` — 读取配置的 JSON Schema
- `config.apply` — **替换**整个配置（危险，需确认）
- `config.patch` — **合并**更新部分配置（推荐）
- `update.run` — 触发 Gateway in-place 升级

### 输出

- `config.get`：`{ ok: true, result: <配置对象> }`
- `config.schema`：`{ ok: true, result: <JSON Schema> }`
- `config.apply` / `config.patch` / `update.run`：`{ ok: true, result: <gateway 响应> }`
- `restart`：重启调度结果

---

\*最后更新：2026-s k l
