---
summary: "OpenClaw 工具和插件概述：代理可以做什么以及如何扩展它"
read_when:
  - 您想了解 OpenClaw 提供哪些工具
  - 您需要配置、允许或拒绝工具
  - 您正在内置工具、技能和插件之间做决定
title: "工具和插件"
---

# 工具和插件

代理除了生成文本之外所做的一切都通过**工具**完成。
工具是代理读取文件、运行命令、浏览网页、发送
消息和与设备交互的方式。

## 工具、技能和插件

OpenClaw 有三个协同工作的层：

<Steps>
  <Step title="工具是代理调用的对象">
    工具是代理可以调用的类型化函数（例如 `exec`、`browser`、
    `web_search`、`message`）。OpenClaw 提供了一组**内置工具**，
    插件可以注册额外的工具。

    代理将工具视为发送到模型 API 的结构化函数定义。

  </Step>

  <Step title="技能教导代理何时以及如何使用工具">
    技能是注入到系统提示中的 markdown 文件（`SKILL.md`）。
    技能为代理提供上下文、约束和分步指导，以便
    有效使用工具。技能存在于您的工作区、共享文件夹中，
    或在插件中提供。

    [技能参考](/tools/skills) | [创建技能](/tools/creating-skills)

  </Step>

  <Step title="插件将所有内容打包在一起">
    插件是一个包，可以注册任意组合的功能：
    频道、模型提供商、工具、技能、语音、实时转录、
    实时语音、媒体理解、图像生成、视频生成、
    网页获取、网络搜索等。一些插件是**核心**的（随 OpenClaw 一起提供），
    其他是**外部**的（由社区在 npm 上发布）。

    [安装和配置插件](/tools/plugin) | [构建自己的插件](/plugins/building-plugins)

  </Step>
</Steps>

## 内置工具

这些工具随 OpenClaw 一起提供，无需安装任何插件即可使用：

| 工具                                       | 功能                                                              | 页面                                        |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| `exec` / `process`                         | 运行 shell 命令，管理后台进程                                     | [Exec](/tools/exec)                         |
| `code_execution`                           | 运行沙盒化的远程 Python 分析                                      | [代码执行](/tools/code-execution)           |
| `browser`                                  | 控制 Chromium 浏览器（导航、点击、截图）                           | [浏览器](/tools/browser)                    |
| `web_search` / `x_search` / `web_fetch`    | 搜索网络，搜索 X 帖子，获取页面内容                               | [Web](/tools/web)                           |
| `read` / `write` / `edit`                  | 工作区中的文件 I/O                                                |                                             |
| `apply_patch`                              | 多块文件补丁                                                     | [应用补丁](/tools/apply-patch)              |
| `message`                                  | 跨所有频道发送消息                                               | [代理发送](/tools/agent-send)               |
| `canvas`                                   | 驱动节点画布（显示、评估、快照）                                  |                                             |
| `nodes`                                    | 发现并定位配对设备                                               |                                             |
| `cron` / `gateway`                         | 管理计划任务；检查、修补、重启或更新网关                         |                                             |
| `image` / `image_generate`                 | 分析或生成图像                                                   | [图像生成](/tools/image-generation)         |
| `music_generate`                           | 生成音乐曲目                                                     | [音乐生成](/tools/music-generation)         |
| `video_generate`                           | 生成视频                                                         | [视频生成](/tools/video-generation)         |
| `tts`                                      | 一次性文本到语音转换                                             | [TTS](/tools/tts)                           |
| `sessions_*` / `subagents` / `agents_list` | 会话管理、状态和子代理编排                                       | [子代理](/tools/subagents)                  |
| `session_status`                           | 轻量级 `/status` 风格的回读和会话模型覆盖                         | [会话工具](/concepts/session-tool)          |

对于图像工作，使用 `image` 进行分析，使用 `image_generate` 进行生成或编辑。如果您目标是 `openai/*`、`google/*`、`fal/*` 或其他非默认图像提供商，请先配置该提供商的认证/API 密钥。

对于音乐工作，使用 `music_generate`。如果您目标是 `google/*`、`minimax/*` 或其他非默认音乐提供商，请先配置该提供商的认证/API 密钥。

对于视频工作，使用 `video_generate`。如果您目标是 `qwen/*` 或其他非默认视频提供商，请先配置该提供商的认证/API 密钥。

对于工作流驱动的音频生成，当插件如 ComfyUI 注册时，使用 `music_generate`。这与 `tts`（文本到语音）分开。

`session_status` 是会话组中的轻量级状态/回读工具。
它回答关于当前会话的 `/status` 风格问题，并可以
选择性地设置每个会话的模型覆盖；`model=default` 清除该
覆盖。与 `/status` 一样，它可以回填稀疏的令牌/缓存计数器和
来自最新转录使用条目的活动运行时模型标签。

`gateway` 是用于网关操作的仅限所有者的运行时工具：

- `config.schema.lookup` 用于编辑前的一个路径范围的配置子树
- `config.get` 用于当前配置快照 + 哈希
- `config.patch` 用于带有重启的部分配置更新
- `config.apply` 仅用于全配置替换
- `update.run` 用于显式自更新 + 重启

对于部分更改，首选 `config.schema.lookup` 然后 `config.patch`。仅在您有意替换整个配置时使用 `config.apply`。
该工具也拒绝更改 `tools.exec.ask` 或 `tools.exec.security`；
旧版 `tools.bash.*` 别名标准化为相同的受保护 exec 路径。

### 插件提供的工具

插件可以注册额外的工具。一些示例：

- [Lobster](/tools/lobster) — 带有可恢复批准的类型化工作流运行时
- [LLM 任务](/tools/llm-task) — 用于结构化输出的纯 JSON LLM 步骤
- [音乐生成](/tools/music-generation) — 带有工作流支持的提供商的共享 `music_generate` 工具
- [差异](/tools/diffs) — 差异查看器和渲染器
- [OpenProse](/prose) — 以 markdown 为先的工作流编排

## 工具配置

### 允许和拒绝列表

通过配置中的 `tools.allow` / `tools.deny` 控制代理可以调用哪些工具。拒绝总是优先于允许。

```json5
{
  tools: {
    allow: ["group:fs", "browser", "web_search"],
    deny: ["exec"],
  },
}
```

### 工具配置文件

`tools.profile` 在应用 `allow`/`deny` 之前设置基础允许列表。
按代理覆盖：`agents.list[].tools.profile`。

| 配置文件    | 包含内容                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `full`      | 无限制（与未设置相同）                                                                                                                    |
| `coding`    | `group:fs`, `group:runtime`, `group:web`, `group:sessions`, `group:memory`, `cron`, `image`, `image_generate`, `music_generate`, `video_generate` |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`                                                     |
| `minimal`   | 仅 `session_status`                                                                                                                         |

### 工具组

在允许/拒绝列表中使用 `group:*` 简写：

| 组              | 工具                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `group:runtime`  | exec, process, code_execution（`bash` 被接受为 `exec` 的别名）                                            |
| `group:fs`       | read, write, edit, apply_patch                                                                            |
| `group:sessions` | sessions_list, sessions_history, sessions_send, sessions_spawn, sessions_yield, subagents, session_status |
| `group:memory`   | memory_search, memory_get                                                                                 |
| `group:web`      | web_search, x_search, web_fetch                                                                           |
| `group:ui`       | browser, canvas                                                                                           |
| `group:automation` | cron, gateway                                                                                             |
| `group:messaging` | message                                                                                                   |
| `group:nodes`    | nodes                                                                                                     |
| `group:agents`   | agents_list                                                                                               |
| `group:media`    | image, image_generate, music_generate, video_generate, tts                                                |
| `group:openclaw` | 所有内置 OpenClaw 工具（不包括插件工具）                                                               |

`sessions_history` 返回一个有界的、经过安全过滤的回忆视图。它从助手文本中剥离
思考标签、`<relevant-memories>` 脚手架、纯文本工具调用 XML
有效负载（包括 `<tool_call>...</tool_call>`、
`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>`、
`<function_calls>...</function_calls>` 和截断的工具调用块）、
降级的工具调用脚手架、泄漏的 ASCII/全宽模型控制
令牌和格式错误的 MiniMax 工具调用 XML，然后应用
编辑/截断和可能的超大行占位符，而不是充当原始转录转储。

### 特定于提供商的限制

使用 `tools.byProvider` 为特定提供商限制工具，而不
更改全局默认值：

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```