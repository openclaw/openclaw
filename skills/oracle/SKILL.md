---
name: oracle
description: Use oracle CLI to bundle prompts and files for second-model debugging, refactor, design, or review checks.
homepage: https://askoracle.dev
metadata:
  {
    "openclaw":
      {
        "emoji": "🧿",
        "requires": { "bins": ["oracle"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "@steipete/oracle",
              "bins": ["oracle"],
              "label": "Install oracle (node)",
            },
          ],
      },
  }
---

# oracle — 最佳使用

Oracle 将您的提示+选定文件打包成一个"一次"请求，以便另一个模型可以用真实的仓库上下文回答（API 或浏览器自动化）。将输出视为咨询性意见：根据代码+测试进行验证。

## 主要用例（浏览器，GPT‑5.2 Pro）

此处默认工作流程：在 ChatGPT 中使用 GPT‑5.2 Pro 的 `--engine browser`。这是常见的"长思考"路径：~10 分钟到 ~1 小时是正常的；预计有一个可以重新附加的存储会话。

推荐默认值：

- Engine：browser（`--engine browser`）
- Model：GPT‑5.2 Pro（`--model gpt-5.2-pro` 或 `--model "5.2 Pro"`）

## 最佳路径

1. 选择一个紧密的文件集（最少文件但仍包含真相）。
2. 预览 payload + 令牌消耗（`--dry-run` + `--files-report`）。
3. 使用浏览器模式进行常规 GPT‑5.2 Pro 工作流程；仅在您明确想要时才使用 API。
4. 如果运行分离/超时：重新附加到存储的会话（不要重新运行）。

## 命令（首选）

- 帮助：
  - `oracle --help`
  - 如果二进制文件未安装：`npx -y @steipete/oracle --help`（避免在此使用 `pnpx`；sqlite 绑定）。

- 预览（无令牌）：
  - `oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `oracle --dry-run full -p "<task>" --file "src/**"`

- 令牌合理性检查：
  - `oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- 浏览器运行（主要路径；长时间运行是正常的）：
  - `oracle --engine browser --model gpt-5.2-pro -p "<task>" --file "src/**"`

- 手动粘贴回退：
  - `oracle --render --copy -p "<task>" --file "src/**"`
  - 注意：`--copy` 是 `--copy-markdown` 的隐藏别名。

## 附加文件（`--file`）

`--file` 接受文件、目录和 glob。您可以通过多次传递它；条目可以是逗号分隔的。

- 包含：
  - `--file "src/**"`
  - `--file src/index.ts`
  - `--file docs --file README.md`

- 排除：
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

- 默认值（实现行为）：
  - 默认忽略的目录：`node_modules`、`dist`、`coverage`、`.git`、`.turbo`、`.next`、`build`、`tmp`（除非作为字面目录/文件显式传递，否则跳过）。
  - 扩展 glob 时遵守 `.gitignore`。
  - 不跟随符号链接。
  - 除非通过模式选择加入，否则过滤点文件（例如 `--file ".github/**"`）。
  - 拒绝大于 1 MB 的文件。

## Engines（API vs 浏览器）

- 自动选择：当设置 `OPENAI_API_KEY` 时为 `api`；否则为 `browser`。
- 浏览器仅支持 GPT + Gemini；要使用 Claude/Grok/Codex 或多元模型运行，请使用 `--engine api`。
- 浏览器附件：
  - `--browser-attachments auto|never|always`（auto 在 ~60k 字符内内联粘贴，然后上传）。
- 远程浏览器主机：
  - 主机：`oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - 客户端：`oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## 会话 + slugs

- 存储在 `~/.oracle/sessions` 下（使用 `ORACLE_HOME_DIR` 覆盖）。
- 运行可能会分离或花费很长时间（浏览器 + GPT‑5.2 Pro 通常是这样）。如果 CLI 超时：不要重新运行；重新附加。
  - 列表：`oracle status --hours 72`
  - 附加：`oracle session <id> --render`
- 使用 `--slug "<3-5 words>"` 保持会话 ID 可读。
- 存在重复提示保护；仅在您真正想要全新运行时使用 `--force`。

## 提示模板（高信号）

Oracle 从**零**项目知识开始。假设模型无法推断您的技术栈、构建工具、约定或"显而易见"的路径。包括：

- 项目简介（技术栈 + 构建/测试命令 + 平台约束）。
- "东西在哪里"（关键目录、入口点、配置文件、边界）。
- 确切的问题 + 您尝试的内容 + 错误文本（逐字）。
- 约束（"不要更改 X"、"必须保持公共 API"等）。
- 期望输出（"返回补丁计划 + 测试"、"给出 3 个选项及权衡"）。

## 安全

- 默认不要附加秘密（`.env`、密钥文件、auth token）。积极编辑；仅分享所需的内容。

## "详尽提示"恢复模式

对于长期调查，编写一个独立提示 + 文件集，以便您可以在几天后重新运行：

- 6–30 句项目简介 + 目标。
- 重现步骤 + 确切错误 + 您尝试的内容。
- 附加所有需要的上下文文件（入口点、配置、关键模块、文档）。

Oracle 运行是一次性的；模型不记得之前的运行。"恢复上下文"意味着使用相同的提示 + `--file …` 集重新运行（或者重新附加仍在运行的存储会话）。
