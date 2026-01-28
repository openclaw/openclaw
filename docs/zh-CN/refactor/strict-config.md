---
read_when:
  - 设计或实现配置验证行为时
  - 处理配置迁移或 doctor 工作流时
  - 处理插件配置 schema 或插件加载控制时
summary: 严格配置验证 + 仅通过 doctor 执行迁移
title: 严格配置验证
x-i18n:
  generated_at: "2026-02-01T21:36:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 5bc7174a67d2234e763f21330d8fe3afebc23b2e5c728a04abcc648b453a91cc
  source_path: refactor/strict-config.md
  workflow: 15
---

# 严格配置验证（仅通过 doctor 执行迁移）

## 目标

- **在所有层级（根级 + 嵌套级）拒绝未知配置键**。
- **拒绝没有 schema 的插件配置**；不加载该插件。
- **移除加载时的遗留自动迁移**；迁移仅通过 doctor 执行。
- **启动时自动运行 doctor（dry-run 模式）**；如果配置无效，阻止非诊断命令。

## 非目标

- 加载时的向后兼容性（遗留键不会自动迁移）。
- 静默丢弃未识别的键。

## 严格验证规则

- 配置必须在每个层级精确匹配 schema。
- 未知键是验证错误（根级和嵌套级均不允许透传）。
- `plugins.entries.<id>.config` 必须由插件的 schema 进行验证。
  - 如果插件缺少 schema，**拒绝插件加载**并显示明确的错误信息。
- 未知的 `channels.<id>` 键是错误，除非插件清单声明了该渠道 id。
- 所有插件都必须提供插件清单（`openclaw.plugin.json`）。

## 插件 schema 强制执行

- 每个插件为其配置提供严格的 JSON Schema（内联在清单中）。
- 插件加载流程：
  1. 解析插件清单 + schema（`openclaw.plugin.json`）。
  2. 根据 schema 验证配置。
  3. 如果缺少 schema 或配置无效：阻止插件加载，记录错误。
- 错误信息包括：
  - 插件 id
  - 原因（缺少 schema / 配置无效）
  - 验证失败的路径
- 已禁用的插件保留其配置，但 Doctor + 日志会显示警告。

## Doctor 流程

- 每次加载配置时都会运行 Doctor（默认 dry-run 模式）。
- 如果配置无效：
  - 打印摘要 + 可操作的错误信息。
  - 提示：`openclaw doctor --fix`。
- `openclaw doctor --fix`：
  - 应用迁移。
  - 移除未知键。
  - 写入更新后的配置。

## 命令控制（配置无效时）

允许执行（仅限诊断命令）：

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

其他所有命令必须直接失败并提示："Config invalid. Run `openclaw doctor --fix`."

## 错误用户体验格式

- 单个摘要标题。
- 分组展示：
  - 未知键（完整路径）
  - 遗留键 / 需要迁移
  - 插件加载失败（插件 id + 原因 + 路径）

## 实现涉及的文件

- `src/config/zod-schema.ts`：移除根级 passthrough；所有对象使用 strict 模式。
- `src/config/zod-schema.providers.ts`：确保渠道 schema 为 strict 模式。
- `src/config/validation.ts`：遇到未知键时失败；不应用遗留迁移。
- `src/config/io.ts`：移除遗留自动迁移；始终运行 doctor dry-run。
- `src/config/legacy*.ts`：将用法迁移到仅限 doctor 使用。
- `src/plugins/*`：添加 schema 注册表 + 加载控制。
- `src/cli` 中的 CLI 命令控制。

## 测试

- 未知键拒绝（根级 + 嵌套级）。
- 插件缺少 schema → 插件加载被阻止并显示明确错误。
- 配置无效 → Gateway网关启动被阻止，诊断命令除外。
- Doctor dry-run 自动运行；`doctor --fix` 写入修正后的配置。
