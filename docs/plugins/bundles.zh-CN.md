---
summary: "安装和使用 Codex、Claude 和 Cursor 包作为 OpenClaw 插件"
read_when:
  - 您想要安装 Codex、Claude 或兼容 Cursor 的包
  - 您需要了解 OpenClaw 如何将包内容映射到原生功能
  - 您正在调试包检测或缺失的功能
title: "插件包"
---

# 插件包

OpenClaw 可以从三个外部生态系统安装插件：**Codex**、**Claude**
和 **Cursor**。这些被称为**包**——内容和元数据包，OpenClaw
将它们映射到原生功能，如技能、钩子和 MCP 工具。

<Info>
  包**不是**与原生 OpenClaw 插件相同的东西。原生插件在进程内运行，
  可以注册任何功能。包是内容包，具有
  选择性功能映射和更窄的信任边界。
</Info>

## 包存在的原因

许多有用的插件以 Codex、Claude 或 Cursor 格式发布。与其要求作者将它们重写为原生 OpenClaw 插件，OpenClaw
检测这些格式并将其支持的内容映射到原生功能集。这意味着您可以安装 Claude 命令包或 Codex 技能包
并立即使用它。

## 安装包

<Steps>
  <Step title="从目录、存档或市场安装">
    ```bash
    # 本地目录
    openclaw plugins install ./my-bundle

    # 存档
    openclaw plugins install ./my-bundle.tgz

    # Claude 市场
    openclaw plugins marketplace list <marketplace-name>
    openclaw plugins install <plugin-name>@<marketplace-name>
    ```

  </Step>

  <Step title="验证检测">
    ```bash
    openclaw plugins list
    openclaw plugins inspect <id>
    ```

    包显示为 `Format: bundle`，子类型为 `codex`、`claude` 或 `cursor`。

  </Step>

  <Step title="重启并使用">
    ```bash
    openclaw gateway restart
    ```

    映射的功能（技能、钩子、MCP 工具、LSP 默认值）在下次会话中可用。

  </Step>
</Steps>

## OpenClaw 从包中映射的内容

并非每个包功能现在都能在 OpenClaw 中运行。以下是可用的功能以及被检测但尚未连接的功能。

### 现在支持

| 功能       | 映射方式                                                                                   | 适用于     |
| --------- | ---------------------------------------------------------------------------------------- | ---------- |
| 技能内容   | 包技能根目录加载为正常的 OpenClaw 技能                                                   | 所有格式    |
| 命令       | `commands/` 和 `.cursor/commands/` 被视为技能根目录                                       | Claude, Cursor |
| 钩子包     | OpenClaw 风格的 `HOOK.md` + `handler.ts` 布局                                            | Codex      |
| MCP 工具   | 包 MCP 配置合并到嵌入式 Pi 设置中；支持的 stdio 和 HTTP 服务器被加载                       | 所有格式    |
| LSP 服务器 | Claude `.lsp.json` 和清单声明的 `lspServers` 合并到嵌入式 Pi LSP 默认值                  | Claude     |
| 设置       | Claude `settings.json` 导入为嵌入式 Pi 默认值                                             | Claude     |

#### 技能内容

- 包技能根目录加载为正常的 OpenClaw 技能根目录
- Claude `commands` 根目录被视为额外的技能根目录
- Cursor `.cursor/commands` 根目录被视为额外的技能根目录

这意味着 Claude  markdown 命令文件通过正常的 OpenClaw 技能加载器工作。Cursor 命令 markdown 通过相同的路径工作。

#### 钩子包

- 包钩子根目录**仅**在使用正常的 OpenClaw 钩子包布局时工作。今天这主要是 Codex 兼容的情况：
  - `HOOK.md`
  - `handler.ts` 或 `handler.js`

#### Pi 的 MCP

- 启用的包可以贡献 MCP 服务器配置
- OpenClaw 将包 MCP 配置合并到有效的嵌入式 Pi 设置中，作为
  `mcpServers`
- OpenClaw 通过启动 stdio 服务器或连接到 HTTP 服务器，在嵌入式 Pi 代理轮次期间暴露支持的包 MCP 工具
- 项目本地 Pi 设置在包默认值之后仍然适用，因此工作区
  设置可以在需要时覆盖包 MCP 条目
- 包 MCP 工具目录在注册前确定性排序，因此
  上游 `listTools()` 顺序更改不会破坏提示缓存工具块

##### 传输

MCP 服务器可以使用 stdio 或 HTTP 传输：

**Stdio** 启动子进程：

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "command": "node",
        "args": ["server.js"],
        "env": { "PORT": "3000" }
      }
    }
  }
}
```

**HTTP** 默认通过 `sse` 连接到运行中的 MCP 服务器，或在请求时通过 `streamable-http`：

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "url": "http://localhost:3100/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer ${MY_SECRET_TOKEN}"
        },
        "connectionTimeoutMs": 30000
      }
    }
  }
}
```

- `transport` 可以设置为 `"streamable-http"` 或 `"sse"`；当省略时，OpenClaw 使用 `sse`
- 只允许 `http:` 和 `https:` URL 方案
- `headers` 值支持 `${ENV_VAR}` 插值
- 同时具有 `command` 和 `url` 的服务器条目被拒绝
- URL 凭据（用户信息和查询参数）从工具描述和日志中被编辑
- `connectionTimeoutMs` 覆盖默认的 30 秒连接超时，适用于 stdio 和 HTTP 传输

##### 工具命名

OpenClaw 以 `serverName__toolName` 形式的提供商安全名称注册包 MCP 工具。例如，一个键为 `"vigil-harbor"` 并暴露 `memory_search` 工具的服务器注册为 `vigil-harbor__memory_search`。

- `A-Za-z0-9_-` 之外的字符被替换为 `-`
- 服务器前缀限制为 30 个字符
- 完整工具名称限制为 64 个字符
- 空服务器名称回退到 `mcp`
- 冲突的已清理名称通过数字后缀消除歧义
- 最终暴露的工具顺序按安全名称确定性排序，以保持重复的 Pi 轮次缓存稳定

#### 嵌入式 Pi 设置

- 当包启用时，Claude `settings.json` 被导入为默认的嵌入式 Pi 设置
- OpenClaw 在应用前清理 shell 覆盖键

已清理的键：

- `shellPath`
- `shellCommandPrefix`

#### 嵌入式 Pi LSP

- 启用的 Claude 包可以贡献 LSP 服务器配置
- OpenClaw 加载 `.lsp.json` 以及任何清单声明的 `lspServers` 路径
- 包 LSP 配置合并到有效的嵌入式 Pi LSP 默认值中
- 今天只有支持的 stdio 支持的 LSP 服务器可运行；不支持的
  传输仍然会显示在 `openclaw plugins inspect <id>` 中

### 已检测但未执行

这些被识别并显示在诊断中，但 OpenClaw 不运行它们：

- Claude `agents`、`hooks.json` 自动化、`outputStyles`
- Cursor `.cursor/agents`、`.cursor/hooks.json`、`.cursor/rules`
- Codex 内联/应用元数据超出能力报告

## 包格式

<AccordionGroup>
  <Accordion title="Codex 包">
    标记：`.codex-plugin/plugin.json`

    可选内容：`skills/`、`hooks/`、`.mcp.json`、`.app.json`

    当 Codex 包使用技能根目录和 OpenClaw 风格的钩子包目录（`HOOK.md` + `handler.ts`）时，它们最适合 OpenClaw。

  </Accordion>

  <Accordion title="Claude 包">
    两种检测模式：

    - **基于清单：** `.claude-plugin/plugin.json`
    - **无清单：** 默认 Claude 布局（`skills/`、`commands/`、`agents/`、`hooks/`、`.mcp.json`、`.lsp.json`、`settings.json`）

    Claude 特定行为：

    - `commands/` 被视为技能内容
    - `settings.json` 导入到嵌入式 Pi 设置中（shell 覆盖键被清理）
    - `.mcp.json` 向嵌入式 Pi 暴露支持的 stdio 工具
    - `.lsp.json` 加上清单声明的 `lspServers` 路径加载到嵌入式 Pi LSP 默认值中
    - `hooks/hooks.json` 被检测但不执行
    - 清单中的自定义组件路径是累加的（它们扩展默认值，而不是替换它们）

  </Accordion>

  <Accordion title="Cursor 包">
    标记：`.cursor-plugin/plugin.json`

    可选内容：`skills/`、`.cursor/commands/`、`.cursor/agents/`、`.cursor/rules/`、`.cursor/hooks.json`、`.mcp.json`

    - `.cursor/commands/` 被视为技能内容
    - `.cursor/rules/`、`.cursor/agents/` 和 `.cursor/hooks.json` 仅检测

  </Accordion>
</AccordionGroup>

## 检测优先级

OpenClaw 首先检查原生插件格式：

1. `openclaw.plugin.json` 或带有 `openclaw.extensions` 的有效 `package.json` — 视为**原生插件**
2. 包标记（`.codex-plugin/`、`.claude-plugin/` 或默认 Claude/Cursor 布局）— 视为**包**

如果目录同时包含两者，OpenClaw 使用原生路径。这可以防止双格式包作为包被部分安装。

## 安全性

包比原生插件具有更窄的信任边界：

- OpenClaw **不**在进程中加载任意包运行时模块
- 技能和钩子包路径必须保持在插件根目录内（边界检查）
- 设置文件通过相同的边界检查读取
- 支持的 stdio MCP 服务器可能作为子进程启动

这使得包默认更安全，但您仍然应该将第三方包视为它们所暴露功能的可信内容。

## 故障排除

<AccordionGroup>
  <Accordion title="包被检测但功能不运行">
    运行 `openclaw plugins inspect <id>`。如果列出了功能但标记为
    未连接，那是产品限制 — 不是安装损坏。
  </Accordion>

  <Accordion title="Claude 命令文件不出现">
    确保包已启用，并且 markdown 文件位于检测到的 `commands/` 或 `skills/` 根目录内。
  </Accordion>

  <Accordion title="Claude 设置不应用">
    只支持来自 `settings.json` 的嵌入式 Pi 设置。OpenClaw 不
    将包设置视为原始配置补丁。
  </Accordion>

  <Accordion title="Claude 钩子不执行">
    `hooks/hooks.json` 仅检测。如果您需要可运行的钩子，请使用
    OpenClaw 钩子包布局或发布原生插件。
  </Accordion>
</AccordionGroup>

## 相关

- [安装和配置插件](/tools/plugin)
- [构建插件](/plugins/building-plugins) — 创建原生插件
- [插件清单](/plugins/manifest) — 原生清单模式