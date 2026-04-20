---
title: "创建技能"
summary: "使用 SKILL.md 构建和测试自定义工作区技能"
read_when:
  - 你正在工作区中创建新的自定义技能
  - 你需要一个基于 SKILL.md 的技能的快速入门工作流
---

# 创建技能

技能教会代理如何以及何时使用工具。每个技能都是一个包含 `SKILL.md` 文件的目录，该文件带有 YAML 前言和 markdown 说明。

有关技能如何加载和优先级的信息，请参见 [技能](/tools/skills)。

## 创建你的第一个技能

<Steps>
  <Step title="创建技能目录">
    技能位于你的工作区中。创建一个新文件夹：

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/hello-world
    ```

  </Step>

  <Step title="编写 SKILL.md">
    在该目录中创建 `SKILL.md`。前言定义元数据，
    markdown 正文包含给代理的说明。

    ```markdown
    ---
    name: hello_world
    description: 一个简单的打招呼技能。
    ---

    # Hello World 技能

    当用户要求问候时，使用 `echo` 工具说
    "Hello from your custom skill!".
    ```

  </Step>

  <Step title="添加工具（可选）">
    你可以在前言中定义自定义工具架构，或指示代理
    使用现有的系统工具（如 `exec` 或 `browser`）。技能也可以
    与它们记录的工具一起在插件中提供。

  </Step>

  <Step title="加载技能">
    开始一个新会话，以便 OpenClaw 拾取技能：

    ```bash
    # 从聊天
    /new

    # 或重启网关
    openclaw gateway restart
    ```

    验证技能已加载：

    ```bash
    openclaw skills list
    ```

  </Step>

  <Step title="测试它">
    发送应该触发技能的消息：

    ```bash
    openclaw agent --message "give me a greeting"
    ```

    或者只是与代理聊天并要求问候。

  </Step>
</Steps>

## 技能元数据参考

YAML 前言支持这些字段：

| 字段                               | 是否必需 | 描述                                         |
| ----------------------------------- | -------- | ------------------------------------------- |
| `name`                              | 是       | 唯一标识符（snake_case）                      |
| `description`                       | 是       | 显示给代理的一行描述                           |
| `metadata.openclaw.os`              | 否       | 操作系统过滤器（`["darwin"]`、`["linux"]` 等） |
| `metadata.openclaw.requires.bins`   | 否       | PATH 上的必需二进制文件                        |
| `metadata.openclaw.requires.config` | 否       | 必需的配置键                                  |

## 最佳实践

- **简洁明了** — 指导模型做什么，而不是如何成为 AI
- **安全第一** — 如果你的技能使用 `exec`，确保提示不允许来自不受信任输入的任意命令注入
- **本地测试** — 在分享之前使用 `openclaw agent --message "..."` 进行测试
- **使用 ClawHub** — 在 [ClawHub](https://clawhub.ai) 浏览和贡献技能

## 技能的位置

| 位置                        | 优先级 | 范围                 |
| ------------------------------- | ---------- | --------------------- |
| `\<workspace\>/skills/`         | 最高    | 每代理             |
| `\<workspace\>/.agents/skills/` | 高       | 每工作区代理   |
| `~/.agents/skills/`             | 中       | 共享代理配置文件  |
| `~/.openclaw/skills/`           | 中       | 共享（所有代理）   |
| 捆绑（随 OpenClaw 一起提供） | 低        | 全局                |
| `skills.load.extraDirs`         | 最低     | 自定义共享文件夹 |

## 相关

- [技能参考](/tools/skills) — 加载、优先级和门控规则
- [技能配置](/tools/skills-config) — `skills.*` 配置架构
- [ClawHub](/tools/clawhub) — 公共技能注册表
- [构建插件](/plugins/building-plugins) — 插件可以提供技能