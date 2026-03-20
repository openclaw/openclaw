---
summary: "从零创建 OpenClaw Channel 插件的完整步骤指南"
read_when:
  - 你想创建一个新的 OpenClaw Channel 插件
  - 需要理解插件 SDK 导入模式
  - 正在向 OpenClaw 添加新的 Channel 或 Provider
title: "构建扩展"
---

# 构建扩展

本指南介绍如何从零创建一个 OpenClaw 扩展。扩展可以添加 Channel、模型 Provider、工具或其他功能。

## 前置条件

- 已克隆 OpenClaw 仓库并安装依赖（`pnpm install`）
- 熟悉 TypeScript（ESM）

## 扩展目录结构

每个扩展位于 `extensions/<name>/`，遵循以下布局：

```
extensions/my-channel/
├── package.json          # npm 元数据 + openclaw 配置
├── index.ts              # 入口点（defineChannelPluginEntry）
├── setup-entry.ts        # Setup 向导（可选）
├── api.ts                # 公开 contract barrel（可选）
├── runtime-api.ts        # 内部 runtime barrel（可选）
└── src/
    ├── channel.ts        # Channel 适配器实现
    ├── runtime.ts        # Runtime 接线
    └── *.test.ts         # 共置测试
```

## 步骤 1：创建 package

创建 `extensions/my-channel/package.json`：

```json
{
  "name": "@openclaw/my-channel",
  "version": "2026.1.1",
  "description": "OpenClaw My Channel 插件",
  "type": "module",
  "dependencies": {},
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "selectionLabel": "My Channel（插件）",
      "docsPath": "/channels/my-channel",
      "docsLabel": "my-channel",
      "blurb": "Channel 的简短描述。",
      "order": 80
    },
    "install": {
      "npmSpec": "@openclaw/my-channel",
      "localPath": "extensions/my-channel"
    }
  }
}
```

`openclaw` 字段告诉插件系统你的扩展提供了什么。对于 Provider 插件，使用 `providers` 而非 `channel`。

## 步骤 2：定义入口点

创建 `extensions/my-channel/index.ts`：

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

export default defineChannelPluginEntry({
  id: "my-channel",
  name: "My Channel",
  description: "将 OpenClaw 连接到 My Channel",
  plugin: {
    // Channel 适配器实现
  },
});
```

对于 Provider 插件，使用 `definePluginEntry` 替代。

## 步骤 3：从聚焦子路径导入

插件 SDK 暴露许多聚焦子路径。请始终从特定子路径导入，而非 monolithic root：

```typescript
// 正确：聚焦子路径
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";

// 错误：monolithic root（lint 会拒绝）
import { ... } from "openclaw/plugin-sdk";
```

常用子路径：

| 子路径                              | 用途                         |
| ----------------------------------- | ---------------------------- |
| `plugin-sdk/core`                   | 插件入口定义、基础类型       |
| `plugin-sdk/channel-setup`          | 可选 setup 适配器/向导       |
| `plugin-sdk/channel-pairing`        | DM pairing 机制              |
| `plugin-sdk/channel-reply-pipeline` | 前缀 + typing 回复接线       |
| `plugin-sdk/channel-config-schema`  | Config schema 构建器         |
| `plugin-sdk/channel-policy`         | Group/DM 策略辅助            |
| `plugin-sdk/secret-input`           | Secret 输入解析/辅助         |
| `plugin-sdk/webhook-ingress`        | Webhook 请求/目标辅助        |
| `plugin-sdk/runtime-store`          | 持久化插件存储               |
| `plugin-sdk/allow-from`             | Allowlist 解析               |
| `plugin-sdk/reply-payload`          | 消息回复类型                 |
| `plugin-sdk/provider-onboard`       | Provider onboarding 配置补丁 |
| `plugin-sdk/testing`                | 测试工具                     |

优先使用满足需求的最窄原语。只有当没有专用子路径时，才使用 `channel-runtime` 或其他更大的辅助 barrel。

## 步骤 4：使用本地 barrel 做内部导入

在扩展内部创建 barrel 文件共享内部代码，而非通过插件 SDK 导入：

```typescript
// api.ts — 此扩展的公开 contract
export { MyChannelConfig } from "./src/config.js";
export { MyChannelRuntime } from "./src/runtime.js";

// runtime-api.ts — 仅内部导出（不供生产消费者使用）
export { internalHelper } from "./src/helpers.js";
```

**自引用保护规则**：永远不要从生产文件通过发布的 SDK 合约路径重新导入自己的扩展。内部导入通过 `./api.ts` 或 `./runtime-api.ts` 路由。SDK 合约仅供外部消费者使用。

## 步骤 5：添加插件清单

在扩展根目录创建 `openclaw.plugin.json`：

```json
{
  "id": "my-channel",
  "kind": "channel",
  "channels": ["my-channel"],
  "name": "My Channel 插件",
  "description": "将 OpenClaw 连接到 My Channel"
}
```

完整 schema 见 [Plugin manifest](/zh-CN/plugins/manifest)。

## 步骤 6：用契约测试验证

OpenClaw 对所有注册的插件运行契约测试。添加扩展后，运行：

```bash
pnpm test:contracts:channels   # Channel 插件
pnpm test:contracts:plugins    # Provider 插件
```

契约测试验证插件是否符合预期接口（setup 向导、session 绑定、消息处理、group 策略等）。

单元测试从公开测试面导入测试辅助：

```typescript
import { createTestRuntime } from "openclaw/plugin-sdk/testing";
```

## Lint 规则

三个脚本强制执行 SDK 边界：

1. **禁止 monolithic root 导入** — `openclaw/plugin-sdk` root 会被拒绝
2. **禁止直接 src/ 导入** — 扩展不能直接导入 `../../src/`
3. **禁止自引用** — 扩展不能导入自己的 `plugin-sdk/<name>` 子路径

提交前运行 `pnpm check` 验证所有边界。

## 提交前检查清单

- [ ] `package.json` 有正确的 `openclaw` 元数据
- [ ] 入口使用 `defineChannelPluginEntry` 或 `definePluginEntry`
- [ ] 所有导入使用聚焦的 `plugin-sdk/<subpath>` 路径
- [ ] 内部导入使用本地 barrel，无 SDK 自引用
- [ ] `openclaw.plugin.json` 清单存在且有效
- [ ] 契约测试通过（`pnpm test:contracts`）
- [ ] 单元测试以 `*.test.ts` 共置
- [ ] `pnpm check` 通过（lint + format）
- [ ] 在 `docs/channels/` 或 `docs/plugins/` 下创建文档页
