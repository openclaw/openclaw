---
read_when:
  - 添加或修改技能
  - 更改技能门控或加载规则
summary: 技能：托管型与工作区型、门控规则，以及配置/环境变量连接
title: 技能
x-i18n:
  generated_at: "2026-02-01T21:43:46Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 54685da5885600b367ccdad6342497199fcb168ce33f8cdc00391d993f3bab7e
  source_path: tools/skills.md
  workflow: 15
---

# 技能（OpenClaw）

OpenClaw 使用与 **[AgentSkills](https://agentskills.io) 兼容**的技能文件夹来教智能体如何使用工具。每个技能是一个目录，包含带有 YAML frontmatter 和说明的 `SKILL.md` 文件。OpenClaw 加载**内置技能**以及可选的本地覆盖，并在加载时根据环境、配置和二进制文件是否存在进行过滤。

## 位置和优先级

技能从**三个**位置加载：

1. **内置技能**：随安装包一起分发（npm 包或 OpenClaw.app）
2. **托管/本地技能**：`~/.openclaw/skills`
3. **工作区技能**：`<workspace>/skills`

如果技能名称冲突，优先级为：

`<workspace>/skills`（最高）→ `~/.openclaw/skills` → 内置技能（最低）

此外，你可以通过 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 配置额外的技能文件夹（最低优先级）。

## 按智能体与共享技能

在**多智能体**设置中，每个智能体拥有自己的工作区。这意味着：

- **按智能体技能**位于该智能体专属的 `<workspace>/skills` 中。
- **共享技能**位于 `~/.openclaw/skills`（托管/本地），对同一机器上的**所有智能体**可见。
- **共享文件夹**也可以通过 `skills.load.extraDirs`（最低优先级）添加，如果你希望多个智能体使用同一套技能包。

如果同一技能名称存在于多个位置，适用通常的优先级规则：工作区优先，然后是托管/本地，最后是内置。

## 插件 + 技能

插件可以通过在 `openclaw.plugin.json` 中列出 `skills` 目录（相对于插件根目录的路径）来附带自己的技能。插件技能在插件启用时加载，并参与正常的技能优先级规则。你可以通过插件配置项上的 `metadata.openclaw.requires.config` 进行门控。参见[插件](/plugin)了解发现/配置，参见[工具](/tools)了解这些技能教授的工具功能。

## ClawHub（安装 + 同步）

ClawHub 是 OpenClaw 的公共技能注册中心。浏览地址：[clawhub.com](https://clawhub.com)。使用它来发现、安装、更新和备份技能。完整指南：[ClawHub](/tools/clawhub)。

常用流程：

- 将技能安装到你的工作区：
  - `clawhub install <skill-slug>`
- 更新所有已安装的技能：
  - `clawhub update --all`
- 同步（扫描 + 发布更新）：
  - `clawhub sync --all`

默认情况下，`clawhub` 安装到当前工作目录下的 `./skills`（或回退到已配置的 OpenClaw 工作区）。OpenClaw 在下次会话时将其作为 `<workspace>/skills` 加载。

## 安全说明

- 将第三方技能视为**不可信代码**。启用前请先阅读其内容。
- 对于不可信输入和高风险工具，优先使用沙箱运行。参见[沙箱](/gateway/sandboxing)。
- `skills.entries.*.env` 和 `skills.entries.*.apiKey` 会将密钥注入该智能体轮次的**宿主**进程中（而非沙箱）。请勿将密钥暴露在提示词和日志中。
- 更广泛的威胁模型和检查清单，请参见[安全](/gateway/security)。

## 格式（AgentSkills + Pi 兼容）

`SKILL.md` 必须至少包含：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

说明：

- 我们遵循 AgentSkills 规范的布局/意图。
- 内嵌智能体使用的解析器仅支持**单行** frontmatter 键。
- `metadata` 应为**单行 JSON 对象**。
- 在说明中使用 `{baseDir}` 引用技能文件夹路径。
- 可选的 frontmatter 键：
  - `homepage` — 在 macOS 技能 UI 中显示为"网站"的 URL（也支持通过 `metadata.openclaw.homepage` 设置）。
  - `user-invocable` — `true|false`（默认：`true`）。为 `true` 时，技能作为用户斜杠命令暴露。
  - `disable-model-invocation` — `true|false`（默认：`false`）。为 `true` 时，技能从模型提示词中排除（仍可通过用户调用使用）。
  - `command-dispatch` — `tool`（可选）。设为 `tool` 时，斜杠命令绕过模型直接分派到工具。
  - `command-tool` — 当设置了 `command-dispatch: tool` 时要调用的工具名称。
  - `command-arg-mode` — `raw`（默认）。用于工具分派时，将原始参数字符串转发给工具（不进行核心解析）。

    工具调用参数为：
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`。

## 门控（加载时过滤）

OpenClaw 使用 `metadata`（单行 JSON）**在加载时过滤技能**：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
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

- `always: true` — 始终包含该技能（跳过其他门控）。
- `emoji` — macOS 技能 UI 使用的可选表情符号。
- `homepage` — macOS 技能 UI 中显示为"网站"的可选 URL。
- `os` — 可选的平台列表（`darwin`、`linux`、`win32`）。如果设置，技能仅在这些操作系统上可用。
- `requires.bins` — 列表；每个都必须存在于 `PATH` 中。
- `requires.anyBins` — 列表；至少一个必须存在于 `PATH` 中。
- `requires.env` — 列表；环境变量必须存在**或**在配置中提供。
- `requires.config` — `openclaw.json` 路径列表，必须为真值。
- `primaryEnv` — 与 `skills.entries.<name>.apiKey` 关联的环境变量名。
- `install` — macOS 技能 UI 使用的可选安装器规格数组（brew/node/go/uv/download）。

关于沙箱的说明：

- `requires.bins` 在技能加载时在**宿主**上检查。
- 如果智能体在沙箱中运行，二进制文件也必须存在于**容器内部**。
  通过 `agents.defaults.sandbox.docker.setupCommand`（或自定义镜像）安装它。
  `setupCommand` 在容器创建后运行一次。
  包安装还需要网络出站权限、可写的根文件系统以及沙箱中的 root 用户。
  示例：`summarize` 技能（`skills/summarize/SKILL.md`）需要 `summarize` CLI 存在于沙箱容器中才能在其中运行。

安装器示例：

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
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

说明：

- 如果列出了多个安装器，Gateway 会选择**单个**首选选项（有 brew 时选 brew，否则选 node）。
- 如果所有安装器都是 `download`，OpenClaw 会列出每个条目，以便你查看可用的产物。
- 安装器规格可包含 `os: ["darwin"|"linux"|"win32"]` 以按平台过滤选项。
- Node 安装遵循 `openclaw.json` 中的 `skills.install.nodeManager`（默认：npm；选项：npm/pnpm/yarn/bun）。
  这仅影响**技能安装**；Gateway 运行时仍应使用 Node（不建议将 Bun 用于 WhatsApp/Telegram）。
- Go 安装：如果缺少 `go` 但有 `brew`，Gateway 会先通过 Homebrew 安装 Go，并尽可能将 `GOBIN` 设置为 Homebrew 的 `bin`。
- Download 安装：`url`（必需）、`archive`（`tar.gz` | `tar.bz2` | `zip`）、`extract`（默认：检测到归档时自动）、`stripComponents`、`targetDir`（默认：`~/.openclaw/tools/<skillKey>`）。

如果没有 `metadata.openclaw`，技能始终可用（除非在配置中禁用，或被 `skills.allowBundled` 对内置技能进行了限制）。

## 配置覆盖（`~/.openclaw/openclaw.json`）

内置/托管技能可以切换启用状态并提供环境变量值：

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
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

注意：如果技能名称包含连字符，请给键加引号（JSON5 允许带引号的键）。

配置键默认匹配**技能名称**。如果技能定义了 `metadata.openclaw.skillKey`，请在 `skills.entries` 下使用该键。

规则：

- `enabled: false` 禁用技能，即使它是内置/已安装的。
- `env`：仅在进程中该变量**尚未设置**时注入。
- `apiKey`：为声明了 `metadata.openclaw.primaryEnv` 的技能提供的便捷方式。
- `config`：用于自定义按技能字段的可选容器；自定义键必须放在此处。
- `allowBundled`：仅针对**内置**技能的可选允许列表。如果设置，只有列表中的内置技能才可用（托管/工作区技能不受影响）。

## 环境注入（按智能体运行）

当智能体运行开始时，OpenClaw：

1. 读取技能元数据。
2. 将 `skills.entries.<key>.env` 或 `skills.entries.<key>.apiKey` 应用到 `process.env`。
3. 使用**符合条件**的技能构建系统提示词。
4. 运行结束后恢复原始环境。

这是**限定在智能体运行范围内**的，而非全局 shell 环境。

## 会话快照（性能）

OpenClaw 在**会话开始时**对符合条件的技能进行快照，并在同一会话的后续轮次中复用该列表。对技能或配置的更改在下一个新会话中生效。

技能也可以在会话中途刷新，当技能监视器启用时或当新的符合条件的远程节点出现时（见下文）。可以将其理解为**热重载**：刷新后的列表会在下一个智能体轮次中被使用。

## 远程 macOS 节点（Linux Gateway）

如果 Gateway 运行在 Linux 上，但有一个**macOS 节点**已连接且**允许 `system.run`**（执行审批安全级别未设为 `deny`），OpenClaw 可以在该节点上存在所需二进制文件时，将仅限 macOS 的技能视为可用。智能体应通过 `nodes` 工具（通常是 `nodes.run`）执行这些技能。

这依赖于节点报告其命令支持情况以及通过 `system.run` 进行的二进制探测。如果 macOS 节点之后离线，技能仍然可见；在节点重新连接之前，调用可能会失败。

## 技能监视器（自动刷新）

默认情况下，OpenClaw 监视技能文件夹，并在 `SKILL.md` 文件更改时更新技能快照。在 `skills.load` 下配置：

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

## Token 影响（技能列表）

当有符合条件的技能时，OpenClaw 会将一个紧凑的 XML 可用技能列表注入系统提示词（通过 `pi-coding-agent` 中的 `formatSkillsForPrompt`）。开销是确定性的：

- **基础开销（仅在有 ≥1 个技能时）：**195 个字符。
- **每个技能：**97 个字符 + XML 转义后的 `<name>`、`<description>` 和 `<location>` 值的长度。

公式（字符数）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

说明：

- XML 转义会将 `& < > " '` 展开为实体（`&amp;`、`&lt;` 等），增加长度。
- Token 数量因模型分词器而异。粗略的 OpenAI 风格估算约为 ~4 字符/token，因此**97 字符 ≈ 24 个 token**（每个技能），加上你实际的字段长度。

## 托管技能生命周期

OpenClaw 将一组基线技能作为**内置技能**随安装包（npm 包或 OpenClaw.app）一起分发。`~/.openclaw/skills` 用于本地覆盖（例如，在不更改内置副本的情况下固定/修补某个技能）。工作区技能由用户拥有，在名称冲突时覆盖两者。

## 配置参考

参见[技能配置](/tools/skills-config)了解完整的配置模式。

## 想要更多技能？

浏览 https://clawhub.com。

---
