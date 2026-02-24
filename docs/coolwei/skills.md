# Skills 系统详解

## 什么是 Skills？

Skills 是 OpenClaw Agent 的"操作手册"系统。每个 Skill 是一个 `SKILL.md` 文件，包含特定领域的操作指引（如 1Password CLI 使用、GitHub 操作、天气查询等）。Agent 在处理用户请求时，会自动匹配并按需读取对应的 Skill，按其中的指引完成任务。

Skills 不是代码插件，而是结构化的 Markdown 文档，通过 YAML frontmatter 声明元数据，正文提供操作流程和约束。

## SKILL.md 文件结构

每个 Skill 由一个目录和其中的 `SKILL.md` 文件组成：

```
skills/
├── 1password/
│   ├── SKILL.md          # 主文件
│   └── references/       # 可选：参考文档
├── github/
│   └── SKILL.md
├── weather/
│   └── SKILL.md
└── ...
```

### Frontmatter 格式

```yaml
---
name: 1password
description: Set up and use 1Password CLI (op). Use when installing the CLI...
homepage: https://developer.1password.com/docs/cli/get-started/
metadata:
  openclaw:
    emoji: "🔐"
    requires:
      bins: ["op"] # 需要的命令行工具
      env: ["OP_ACCOUNT"] # 需要的环境变量（可选）
    install:
      - id: brew
        kind: brew
        formula: 1password-cli
        bins: ["op"]
        label: "Install 1Password CLI (brew)"
    always: true # 是否始终加载（不需要匹配）
    primaryEnv: "OP_ACCOUNT"
---
```

关键字段：

| 字段          | 说明                                            |
| ------------- | ----------------------------------------------- |
| `name`        | Skill 唯一标识                                  |
| `description` | 描述，Agent 用来判断是否匹配当前任务            |
| `homepage`    | 相关工具/服务的官方文档链接                     |
| `metadata`    | OpenClaw 特有元数据（依赖、安装方式、门控条件） |

### 正文内容

Frontmatter 之后是 Markdown 正文，通常包含：

- 工作流程步骤
- 命令示例
- 约束和注意事项
- 参考文档引用

## Skills 发现与加载

### 扫描位置

系统在以下位置扫描 `SKILL.md` 文件（按优先级从高到低）：

1. 工作区 skills：`<workspace>/skills/*/SKILL.md`
2. 工作区 `.agents` 目录：`<workspace>/.agents/skills/*/SKILL.md`
3. 用户全局 skills：`~/.agents/skills/*/SKILL.md`
4. 内置 skills：OpenClaw 安装目录下的 `skills/*/SKILL.md`

同名 Skill 按优先级覆盖：工作区版本 > 全局版本 > 内置版本。

### 加载流程（`src/agents/skills/workspace.ts`）

1. 遍历所有 skills 根目录
2. 检测嵌套结构（`dir/skills/*/SKILL.md` 模式）
3. 对每个子目录检查是否存在 `SKILL.md`
4. 读取并解析 frontmatter（名称、描述、元数据）
5. 检查文件大小限制（`maxSkillFileBytes`），超大文件跳过
6. 应用门控条件（`requires.bins`、`requires.env`、`always` 等）
7. 合并去重，生成最终的 skills 列表

### 文件监听（`src/agents/skills/refresh.ts`）

系统使用文件 watcher 监听 `SKILL.md` 的变化：

- 只监听 `*/SKILL.md` 和 `*/*/SKILL.md` 路径模式
- 忽略 `node_modules`、`.git`、大型无关目录
- 文件变更时自动刷新 skills 列表，无需重启 Gateway

## Agent 如何使用 Skills

### 1. 注入 System Prompt

启动 Agent 时，系统将所有可用 skills 的名称和描述组装成 `<available_skills>` 列表，注入到 Agent 的 system prompt 中（`src/agents/system-prompt.ts`）：

```
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.

<available_skills>
- 1password: Set up and use 1Password CLI... (location: ~/.../skills/1password/SKILL.md)
- github: GitHub operations... (location: ~/.../skills/github/SKILL.md)
...
</available_skills>
```

### 2. 按需读取

Agent 收到用户消息后：

1. 扫描 `<available_skills>` 列表中的 `<description>`
2. 如果恰好一个 Skill 明确匹配：用 `read` 工具读取该 `SKILL.md` 完整内容
3. 如果多个可能匹配：选择最具体的那个
4. 如果没有匹配：不读取任何 Skill
5. 读取后按 Skill 正文中的指引执行任务

### 3. 路径缩短

为节省 token，Skill 路径会自动缩短（`~` 替代 home 目录），每个 Skill 节省约 5-6 tokens。

## 门控机制

Skills 支持多种门控条件，控制何时对 Agent 可见：

| 条件            | 说明                                     |
| --------------- | ---------------------------------------- |
| `requires.bins` | 需要特定命令行工具存在（如 `op`、`gh`）  |
| `requires.env`  | 需要特定环境变量已设置                   |
| `always: true`  | 始终加载，不需要匹配                     |
| 文件大小限制    | 超过 `maxSkillFileBytes` 的 Skill 被跳过 |

## 安装回退机制

当 Skill 声明了 `requires.bins` 但工具未安装时，系统提供安装回退（`src/agents/skills-install-fallback.ts`）：

- 读取 Skill 的 `metadata.openclaw.install` 配置
- 支持 `brew`、`npm`、`pip` 等安装方式
- 提示用户安装缺失的依赖

## CLI 命令

```bash
# 列出所有可用 skills
openclaw skills list

# 查看 skill 详情
openclaw skills inspect <name>

# 安装 skill 依赖
openclaw skills install <name>
```

## 内置 Skills 一览

项目内置 50+ 个 Skills，覆盖常见工具和场景：

| 类别      | Skills 示例                                                 |
| --------- | ----------------------------------------------------------- |
| 密码/安全 | `1password`                                                 |
| 开发工具  | `github`, `gh-issues`, `coding-agent`, `tmux`               |
| 笔记/知识 | `apple-notes`, `bear-notes`, `notion`, `obsidian`, `trello` |
| 通信      | `discord`, `slack`, `imsg`, `voice-call`                    |
| 媒体      | `camsnap`, `peekaboo`, `video-frames`, `gifgrep`, `songsee` |
| AI/模型   | `gemini`, `openai-image-gen`, `openai-whisper`              |
| 智能家居  | `openhue`, `sonoscli`                                       |
| 生产力    | `apple-reminders`, `things-mac`, `spotify-player`           |
| 系统工具  | `weather`, `healthcheck`, `session-logs`, `model-usage`     |
| 元技能    | `skill-creator`（用于创建新 Skill）, `summarize`, `oracle`  |

## 相关源码路径

| 文件                                    | 说明                        |
| --------------------------------------- | --------------------------- |
| `src/agents/skills/workspace.ts`        | Skills 加载、合并、快照构建 |
| `src/agents/skills/refresh.ts`          | 文件监听和热刷新            |
| `src/agents/skills/bundled-dir.ts`      | 内置 Skills 目录发现        |
| `src/agents/system-prompt.ts`           | Skills 注入 system prompt   |
| `src/agents/skills-install-fallback.ts` | 安装回退机制                |
| `src/cli/skills-cli.ts`                 | `openclaw skills` CLI 命令  |
| `skills/*/SKILL.md`                     | 内置 Skill 定义文件         |
