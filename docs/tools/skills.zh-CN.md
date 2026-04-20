---
summary: "技能：托管 vs 工作区，门控规则，以及配置/环境连接"
read_when:
  - 添加或修改技能
  - 更改技能门控或加载规则
title: "技能"
---

# 技能 (OpenClaw)

OpenClaw 使用**[AgentSkills](https://agentskills.io)兼容**的技能文件夹来教代理如何使用工具。每个技能都是一个包含带有 YAML 前言和说明的 `SKILL.md` 的目录。OpenClaw 加载**捆绑技能**加上可选的本地覆盖，并在加载时根据环境、配置和二进制文件的存在情况对它们进行过滤。

## 位置和优先级

OpenClaw 从这些来源加载技能：

1. **额外技能文件夹**：通过 `skills.load.extraDirs` 配置
2. **捆绑技能**：随安装一起提供（npm 包或 OpenClaw.app）
3. **托管/本地技能**：`~/.openclaw/skills`
4. **个人代理技能**：`~/.agents/skills`
5. **项目代理技能**：`<workspace>/.agents/skills`
6. **工作区技能**：`<workspace>/skills`

如果技能名称冲突，优先级为：

`<workspace>/skills`（最高）→ `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → 捆绑技能 → `skills.load.extraDirs`（最低）

## 每代理 vs 共享技能

在**多代理**设置中，每个代理都有自己的工作区。这意味着：

- **每代理技能**仅存在于该代理的 `<workspace>/skills` 中。
- **项目代理技能**存在于 `<workspace>/.agents/skills` 中，并应用于该工作区，优先级高于普通工作区 `skills/` 文件夹。
- **个人代理技能**存在于 `~/.agents/skills` 中，并应用于该机器上的所有工作区。
- **共享技能**存在于 `~/.openclaw/skills`（托管/本地）中，对同一机器上的**所有代理**可见。
- **共享文件夹**也可以通过 `skills.load.extraDirs`（最低优先级）添加，如果你想要一个由多个代理使用的通用技能包。

如果相同的技能名称存在于多个地方，通常的优先级适用：工作区优先，然后是项目代理技能，然后是个人代理技能，然后是托管/本地，然后是捆绑，然后是额外目录。

## 代理技能允许列表

技能**位置**和技能**可见性**是分开的控制。

- 位置/优先级决定同名技能的哪个副本获胜。
- 代理允许列表决定代理实际可以使用哪些可见技能。

使用 `agents.defaults.skills` 作为共享基线，然后通过 `agents.list[].skills` 按代理覆盖：

```json5
{
  agents: {
    defaults: {
      skills: ["github", "weather"],
    },
    list: [
      { id: "writer" }, // 继承 github, weather
      { id: "docs", skills: ["docs-search"] }, // 替换默认值
      { id: "locked-down", skills: [] }, // 无技能
    ],
  },
}
```

规则：

- 省略 `agents.defaults.skills` 默认无限制技能。
- 省略 `agents.list[].skills` 以继承 `agents.defaults.skills`。
- 设置 `agents.list[].skills: []` 表示无技能。
- 非空 `agents.list[].skills` 列表是该代理的最终集合；它不会与默认值合并。

OpenClaw 在提示构建、技能斜杠命令发现、沙箱同步和技能快照中应用有效的代理技能集。

## 插件 + 技能

插件可以通过在 `openclaw.plugin.json` 中列出 `skills` 目录（相对于插件根目录的路径）来提供自己的技能。插件技能在插件启用时加载。今天，这些目录被合并到与 `skills.load.extraDirs` 相同的低优先级路径中，因此同名的捆绑、托管、代理或工作区技能会覆盖它们。
你可以通过插件配置条目的 `metadata.openclaw.requires.config` 来门控它们。有关发现/配置，请参见 [插件](/tools/plugin)，有关这些技能教授的工具表面，请参见 [工具](/tools)。

## ClawHub（安装 + 同步）

ClawHub 是 OpenClaw 的公共技能注册表。在 [https://clawhub.ai](https://clawhub.ai) 浏览。使用原生 `openclaw skills` 命令来发现/安装/更新技能，或在需要发布/同步工作流时使用单独的 `clawhub` CLI。
完整指南：[ClawHub](/tools/clawhub)。

常见流程：

- 将技能安装到你的工作区：
  - `openclaw skills install <skill-slug>`
- 更新所有已安装的技能：
  - `openclaw skills update --all`
- 同步（扫描 + 发布更新）：
  - `clawhub sync --all`

原生 `openclaw skills install` 安装到活动工作区的 `skills/` 目录中。单独的 `clawhub` CLI 也安装到当前工作目录下的 `./skills` 中（或回退到配置的 OpenClaw 工作区）。OpenClaw 在下次会话中将其作为 `<workspace>/skills` 拾取。

## 安全注意事项

- 将第三方技能视为**不受信任的代码**。在启用之前阅读它们。
- 对于不受信任的输入和危险工具，优先使用沙箱运行。请参阅 [沙箱](/gateway/sandboxing)。
- 工作区和额外目录技能发现只接受技能根和 `SKILL.md` 文件，其解析的真实路径保持在配置的根目录内。
- 网关支持的技能依赖安装（`skills.install`、入职和技能设置 UI）在执行安装程序元数据之前运行内置的危险代码扫描器。默认情况下，`critical` 发现会被阻止，除非调用者明确设置危险覆盖；可疑发现仍然只会警告。
- `openclaw skills install <slug>` 不同：它将 ClawHub 技能文件夹下载到工作区，不使用上面的安装程序元数据路径。
- `skills.entries.*.env` 和 `skills.entries.*.apiKey` 将密钥注入到**主机**进程中
  对于该代理回合（不是沙箱）。将密钥从提示和日志中保留。
- 有关更广泛的威胁模型和清单，请参见 [安全性](/gateway/security)。

## 格式（AgentSkills + Pi 兼容）

`SKILL.md` 必须至少包含：

```markdown
---
name: image-lab
description: 通过提供商支持的图像工作流生成或编辑图像
---
```

注意：

- 我们遵循 AgentSkills 规范的布局/意图。
- 嵌入式代理使用的解析器仅支持**单行**前言键。
- `metadata` 应该是**单行 JSON 对象**。
- 在说明中使用 `{baseDir}` 来引用技能文件夹路径。
- 可选前言键：
  - `homepage` — 在 macOS 技能 UI 中显示为“网站”的 URL（也通过 `metadata.openclaw.homepage` 支持）。
  - `user-invocable` — `true|false`（默认：`true`）。当为 `true` 时，技能作为用户斜杠命令公开。
  - `disable-model-invocation` — `true|false`（默认：`false`）。当为 `true` 时，技能从模型提示中排除（仍可通过用户调用使用）。
  - `command-dispatch` — `tool`（可选）。当设置为 `tool` 时，斜杠命令绕过模型并直接调度到工具。
  - `command-tool` — 当设置 `command-dispatch: tool` 时要调用的工具名称。
  - `command-arg-mode` — `raw`（默认）。对于工具调度，将原始参数字符串转发到工具（无核心解析）。

    工具使用参数调用：
    `{ command: "<原始参数>", commandName: "<斜杠命令>", skillName: "<技能名称>" }`。

## 门控（加载时过滤器）

OpenClaw **在加载时过滤技能**使用 `metadata`（单行 JSON）：

```markdown
---
name: image-lab
description: 通过提供商支持的图像工作流生成或编辑图像
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` 下的字段：

- `always: true` — 始终包含技能（跳过其他门）。
- `emoji` — macOS 技能 UI 使用的可选表情符号。
- `homepage` — 在 macOS 技能 UI 中显示为“网站”的可选 URL。
- `os` — 可选平台列表（`darwin`、`linux`、`win32`）。如果设置，技能仅在这些操作系统上符合条件。
- `requires.bins` — 列表；每个必须存在于 `PATH` 上。
- `requires.anyBins` — 列表；至少一个必须存在于 `PATH` 上。
- `requires.env` — 列表；环境变量必须存在**或**在配置中提供。
- `requires.config` — 必须为真的 `openclaw.json` 路径列表。
- `primaryEnv` — 与 `skills.entries.<name>.apiKey` 关联的环境变量名称。
- `install` — macOS 技能 UI 使用的可选安装程序规范数组（brew/node/go/uv/download）。

关于沙箱的注意事项：

- `requires.bins` 在技能加载时在**主机**上检查。
- 如果代理被沙箱化，二进制文件也必须**在容器内**存在。
  通过 `agents.defaults.sandbox.docker.setupCommand`（或自定义镜像）安装它。
  `setupCommand` 在容器创建后运行一次。
  包安装还需要网络出口、可写根文件系统和沙箱中的根用户。
  示例：`summarize` 技能（`skills/summarize/SKILL.md`）需要 `summarize` CLI
  在沙箱容器中运行。

安装程序示例：

```markdown
---
name: gemini
description: 使用 Gemini CLI 进行编码辅助和 Google 搜索查询。
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

注意：

- 如果列出了多个安装程序，网关会选择**单个**首选选项（brew 可用时，否则为 node）。
- 如果所有安装程序都是 `download`，OpenClaw 会列出每个条目，以便你可以看到可用的工件。
- 安装程序规范可以包含 `os: ["darwin"|"linux"|"win32"]` 以按平台过滤选项。
- Node 安装遵循 `openclaw.json` 中的 `skills.install.nodeManager`（默认：npm；选项：npm/pnpm/yarn/bun）。
  这仅影响**技能安装**；网关运行时仍应是 Node
  （Bun 不推荐用于 WhatsApp/Telegram）。
- 网关支持的安装程序选择是基于偏好的，而不仅仅是节点：
  当安装规范混合种类时，OpenClaw 在
  `skills.install.preferBrew` 启用且 `brew` 存在时首选 Homebrew，然后是 `uv`，然后是
  配置的节点管理器，然后是其他回退，如 `go` 或 `download`。
- 如果每个安装规范都是 `download`，OpenClaw 会显示所有下载选项
  而不是折叠为一个首选安装程序。
- Go 安装：如果缺少 `go` 且 `brew` 可用，网关会首先通过 Homebrew 安装 Go，并在可能的情况下将 `GOBIN` 设置为 Homebrew 的 `bin`。
- 下载安装：`url`（必需）、`archive`（`tar.gz` | `tar.bz2` | `zip`）、`extract`（默认：检测到存档时自动）、`stripComponents`、`targetDir`（默认：`~/.openclaw/tools/<skillKey>`）。

如果没有 `metadata.openclaw`，技能始终符合条件（除非在配置中禁用或被捆绑技能的 `skills.allowBundled` 阻止）。

## 配置覆盖 (`~/.openclaw/openclaw.json`)

捆绑/托管技能可以切换并提供环境值：

```json5
{
  skills: {
    entries: {
      "image-lab": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // 或纯文本字符串
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

注意：如果技能名称包含连字符，请引用键（JSON5 允许引用键）。

如果你想在 OpenClaw 内部使用库存图像生成/编辑，请使用核心
`image_generate` 工具和 `agents.defaults.imageGenerationModel`，而不是捆绑技能。这里的技能示例适用于自定义或第三方工作流。

对于原生图像分析，使用 `image` 工具和 `agents.defaults.imageModel`。
对于原生图像生成/编辑，使用 `image_generate` 和
`agents.defaults.imageGenerationModel`。如果你选择 `openai/*`、`google/*`、
`fal/*` 或其他提供商特定的图像模型，也请添加该提供商的身份验证/API
密钥。

配置键默认匹配**技能名称**。如果技能定义了
`metadata.openclaw.skillKey`，请在 `skills.entries` 下使用该键。

规则：

- `enabled: false` 禁用技能，即使它是捆绑/安装的。
- `env`：**仅当**变量尚未在进程中设置时才注入。
- `apiKey`：声明 `metadata.openclaw.primaryEnv` 的技能的便利功能。
  支持纯文本字符串或 SecretRef 对象（`{ source, provider, id }`）。
- `config`：自定义每个技能字段的可选包；自定义键必须在这里。
- `allowBundled`：仅**捆绑**技能的可选允许列表。如果设置，只有列表中的捆绑技能符合条件（托管/工作区技能不受影响）。

## 环境注入（每个代理运行）

当代理运行开始时，OpenClaw：

1. 读取技能元数据。
2. 将任何 `skills.entries.<key>.env` 或 `skills.entries.<key>.apiKey` 应用到
   `process.env`。
3. 使用**符合条件的**技能构建系统提示。
4. 运行结束后恢复原始环境。

这**仅限于代理运行**，而不是全局 shell 环境。

对于捆绑的 `claude-cli` 后端，OpenClaw 还将相同的
符合条件的快照实现为临时 Claude Code 插件，并通过
`--plugin-dir` 传递。Claude Code 然后可以使用其原生技能解析器，同时
OpenClaw 仍然拥有优先级、每个代理的允许列表、门控和
`skills.entries.*` 环境/API 密钥注入。其他 CLI 后端仅使用提示
目录。

## 会话快照（性能）

OpenClaw 在**会话开始时**快照符合条件的技能，并在同一会话的后续回合中重用该列表。技能或配置的更改在下次新会话时生效。

当技能监视器启用或出现新的符合条件的远程节点时，技能也可以在会话中期刷新（见下文）。将此视为**热重载**：刷新的列表在下一个代理回合中被拾取。

如果该会话的有效代理技能允许列表发生变化，OpenClaw
刷新快照，使可见技能与当前保持一致
代理。

## 远程 macOS 节点（Linux 网关）

如果网关在 Linux 上运行，但**macOS 节点**已连接**且允许 `system.run`**（Exec 批准安全性未设置为 `deny`），当所需的二进制文件存在于该节点上时，OpenClaw 可以将仅 macOS 技能视为符合条件。代理应通过 `exec` 工具使用 `host=node` 执行这些技能。

这依赖于节点报告其命令支持和通过 `system.run` 进行的 bin 探测。如果 macOS 节点后来离线，技能仍然可见；调用可能会失败，直到节点重新连接。

## 技能监视器（自动刷新）

默认情况下，OpenClaw 监视技能文件夹并在 `SKILL.md` 文件更改时更新技能快照。在 `skills.load` 下配置：

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## 令牌影响（技能列表）

当技能符合条件时，OpenClaw 将可用技能的紧凑 XML 列表注入到系统提示中（通过 `pi-coding-agent` 中的 `formatSkillsForPrompt`）。成本是确定性的：

- **基础开销（仅当 ≥1 技能时）**：195 个字符。
- **每个技能**：97 个字符 + XML 转义的 `<name>`、`<description>` 和 `<location>` 值的长度。

公式（字符）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

注意：

- XML 转义将 `& < > " '` 扩展为实体（`&amp;`、`&lt;` 等），增加长度。
- 令牌计数因模型分词器而异。OpenAI 风格的粗略估计是 ~4 字符/令牌，因此**97 字符 ≈ 24 令牌** per skill plus your actual field lengths。

## 托管技能生命周期

OpenClaw 作为**捆绑技能**随安装一起提供一组基线技能
（npm 包或 OpenClaw.app）。`~/.openclaw/skills` 用于本地
覆盖（例如，固定/修补技能而不更改捆绑
副本）。工作区技能由用户拥有，并在名称冲突时覆盖两者。

## 配置参考

请参阅 [技能配置](/tools/skills-config) 了解完整的配置架构。

## 寻找更多技能？

浏览 [https://clawhub.ai](https://clawhub.ai)。

---

## 相关

- [创建技能](/tools/creating-skills) — 构建自定义技能
- [技能配置](/tools/skills-config) — 技能配置参考
- [斜杠命令](/tools/slash-commands) — 所有可用的斜杠命令
- [插件](/tools/plugin) — 插件系统概述