---
title: "插件设置和配置"
sidebarTitle: "设置和配置"
summary: "设置向导、setup-entry.ts、配置架构和 package.json 元数据"
read_when:
  - 你正在向插件添加设置向导
  - 你需要了解 setup-entry.ts 与 index.ts 的区别
  - 你正在定义插件配置架构或 package.json openclaw 元数据
---

# 插件设置和配置

插件打包（`package.json` 元数据）、清单（`openclaw.plugin.json`）、设置条目和配置架构的参考。

<Tip>
  **寻找演练？** 操作指南在上下文中涵盖打包：
  [通道插件](/plugins/sdk-channel-plugins#step-1-package-and-manifest) 和
  [提供商插件](/plugins/sdk-provider-plugins#step-1-package-and-manifest)。
</Tip>

## 包元数据

你的 `package.json` 需要一个 `openclaw` 字段，告诉插件系统你的插件提供什么：

**通道插件：**

```json
{
  "name": "@myorg/openclaw-my-channel",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "blurb": "Short description of the channel."
    }
  }
}
```

**提供商插件 / ClawHub 发布基线：**

```json openclaw-clawhub-package.json
{
  "name": "@myorg/openclaw-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "compat": {
      "pluginApi": ">=2026.3.24-beta.2",
      "minGatewayVersion": "2026.3.24-beta.2"
    },
    "build": {
      "openclawVersion": "2026.3.24-beta.2",
      "pluginSdkVersion": "2026.3.24-beta.2"
    }
  }
}
```

如果你在 ClawHub 上外部发布插件，这些 `compat` 和 `build` 字段是必需的。规范的发布片段位于 `docs/snippets/plugin-publish/` 中。

### `openclaw` 字段

| 字段         | 类型       | 描述                                                                                              |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `extensions` | `string[]` | 入口点文件（相对于包根目录）                                                                      |
| `setupEntry` | `string`   | 轻量级仅设置入口（可选）                                                                          |
| `channel`    | `object`   | 通道目录元数据，用于设置、选择器、快速入门和状态界面                                              |
| `providers`  | `string[]` | 此插件注册的提供商 id                                                                             |
| `install`    | `object`   | 安装提示：`npmSpec`、`localPath`、`defaultChoice`、`minHostVersion`、`allowInvalidConfigRecovery` |
| `startup`    | `object`   | 启动行为标志                                                                                      |

### `openclaw.channel`

`openclaw.channel` 是通道发现和运行时加载前设置界面的廉价包元数据。

| 字段                                   | 类型       | 含义                                                   |
| -------------------------------------- | ---------- | ------------------------------------------------------ |
| `id`                                   | `string`   | 规范通道 id。                                          |
| `label`                                | `string`   | 主要通道标签。                                         |
| `selectionLabel`                       | `string`   | 选择器/设置标签，当它应与 `label` 不同时。             |
| `detailLabel`                          | `string`   | 用于更丰富的通道目录和状态界面的次要详细标签。         |
| `docsPath`                             | `string`   | 设置和选择链接的文档路径。                             |
| `docsLabel`                            | `string`   | 当文档链接的标签应与通道 id 不同时的覆盖标签。         |
| `blurb`                                | `string`   | 简短的入职/目录描述。                                  |
| `order`                                | `number`   | 通道目录中的排序顺序。                                 |
| `aliases`                              | `string[]` | 通道选择的额外查找别名。                               |
| `preferOver`                           | `string[]` | 此通道应优于的低优先级插件/通道 id。                   |
| `systemImage`                          | `string`   | 通道 UI 目录的可选图标/系统图像名称。                  |
| `selectionDocsPrefix`                  | `string`   | 选择界面中文档链接前的前缀文本。                       |
| `selectionDocsOmitLabel`               | `boolean`  | 在选择文本中直接显示文档路径，而不是带标签的文档链接。 |
| `selectionExtras`                      | `string[]` | 在选择文本中附加的额外短字符串。                       |
| `markdownCapable`                      | `boolean`  | 将通道标记为支持 Markdown，用于出站格式决策。          |
| `exposure`                             | `object`   | 通道可见性控制，用于设置、配置列表和文档界面。         |
| `quickstartAllowFrom`                  | `boolean`  | 使此通道进入标准快速入门 `allowFrom` 设置流程。        |
| `forceAccountBinding`                  | `boolean`  | 即使只有一个账户存在，也需要显式账户绑定。             |
| `preferSessionLookupForAnnounceTarget` | `boolean`  | 为此通道解析公告目标时优先使用会话查找。               |

示例：

```json
{
  "openclaw": {
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "selectionLabel": "My Channel (self-hosted)",
      "detailLabel": "My Channel Bot",
      "docsPath": "/channels/my-channel",
      "docsLabel": "my-channel",
      "blurb": "Webhook-based self-hosted chat integration.",
      "order": 80,
      "aliases": ["mc"],
      "preferOver": ["my-channel-legacy"],
      "selectionDocsPrefix": "Guide:",
      "selectionExtras": ["Markdown"],
      "markdownCapable": true,
      "exposure": {
        "configured": true,
        "setup": true,
        "docs": true
      },
      "quickstartAllowFrom": true
    }
  }
}
```

`exposure` 支持：

- `configured`：在配置/状态样式列表界面中包含通道
- `setup`：在交互式设置/配置选择器中包含通道
- `docs`：在文档/导航界面中标记通道为面向公众

`showConfigured` 和 `showInSetup` 作为旧别名称仍然受支持。首选 `exposure`。

### `openclaw.install`

`openclaw.install` 是包元数据，不是清单元数据。

| 字段                         | 类型             | 含义                                                 |
| ---------------------------- | ---------------- | ---------------------------------------------------- |
| `npmSpec`                    | `string`         | 安装/更新流程的规范 npm 规范。                       |
| `localPath`                  | `string`         | 本地开发或捆绑安装路径。                             |
| `defaultChoice`              | `"npm"  "local"` | 当两者都可用时的首选安装源。                         |
| `minHostVersion`             | `string`         | 支持的最低 OpenClaw 版本，格式为 `>=x.y.z`。         |
| `allowInvalidConfigRecovery` | `boolean`        | 允许捆绑插件重新安装流程从特定的过时配置失败中恢复。 |

如果设置了 `minHostVersion`，安装和清单注册表加载都会强制执行它。较旧的主机跳过插件；无效的版本字符串被拒绝。

`allowInvalidConfigRecovery` 不是损坏配置的通用绕过。它仅用于狭窄的捆绑插件恢复，因此重新安装/设置可以修复已知的升级遗留问题，如缺失的捆绑插件路径或该插件的过时 `channels.<id>` 条目。如果配置因无关原因损坏，安装仍然会失败并告诉操作员运行 `openclaw doctor --fix`。

### 延迟完全加载

通道插件可以通过以下方式选择延迟加载：

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

启用后，OpenClaw 在预监听启动阶段仅加载 `setupEntry`，即使对于已经配置的通道也是如此。完整条目在网关开始监听后加载。

<Warning>
  只有当你的 `setupEntry` 注册了网关在开始监听之前需要的所有内容（通道注册、HTTP 路由、网关方法）时，才启用延迟加载。如果完整条目拥有必需的启动功能，请保持默认行为。
</Warning>

如果你的设置/完整条目注册网关 RPC 方法，请将它们保持在插件特定的前缀上。保留的核心管理命名空间（`config.*`、`exec.approvals.*`、`wizard.*`、`update.*`）保持核心拥有，始终解析为 `operator.admin`。

## 插件清单

每个原生插件必须在包根目录中包含 `openclaw.plugin.json`。OpenClaw 使用此文件在不执行插件代码的情况下验证配置。

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds My Plugin capabilities to OpenClaw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "webhookSecret": {
        "type": "string",
        "description": "Webhook verification secret"
      }
    }
  }
}
```

对于通道插件，添加 `kind` 和 `channels`：

```json
{
  "id": "my-channel",
  "kind": "channel",
  "channels": ["my-channel"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

即使没有配置的插件也必须提供架构。空架构是有效的：

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

请参阅 [插件清单](/plugins/manifest) 了解完整的架构参考。

## ClawHub 发布

对于插件包，使用特定于包的 ClawHub 命令：

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

旧的仅技能发布别名用于技能。插件包应始终使用 `clawhub package publish`。

## 设置条目

`setup-entry.ts` 文件是 `index.ts` 的轻量级替代方案，当 OpenClaw 只需要设置界面（入职、配置修复、禁用通道检查）时加载。

```typescript
// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { myChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(myChannelPlugin);
```

这避免了在设置流程中加载重运行时代码（加密库、CLI 注册、后台服务）。

在侧车模块中保留设置安全导出的捆绑工作区通道可以使用 `openclaw/plugin-sdk/channel-entry-contract` 中的 `defineBundledChannelSetupEntry(...)` 而不是 `defineSetupPluginEntry(...)`。该捆绑契约还支持可选的 `runtime` 导出，以便设置时的运行时接线可以保持轻量级和显式。

**OpenClaw 使用 `setupEntry` 而不是完整条目的情况：**

- 通道已禁用但需要设置/入职界面
- 通道已启用但未配置
- 启用了延迟加载（`deferConfiguredChannelFullLoadUntilAfterListen`）

**`setupEntry` 必须注册的内容：**

- 通道插件对象（通过 `defineSetupPluginEntry`）
- 网关监听前需要的任何 HTTP 路由
- 启动期间需要的任何网关方法

这些启动网关方法仍应避免保留的核心管理命名空间，如 `config.*` 或 `update.*`。

**`setupEntry` 不应包含的内容：**

- CLI 注册
- 后台服务
- 重运行时导入（加密、SDK）
- 仅启动后需要的网关方法

### 狭窄的设置助手导入

对于热设置专用路径，当你只需要部分设置界面时，首选狭窄的设置助手接缝而不是更广泛的 `plugin-sdk/setup` 伞形：

| 导入路径                           | 用途                                                         | 关键导出                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/setup-runtime`         | 设置时的运行时助手，在 `setupEntry` / 延迟通道启动中保持可用 | `createPatchedAccountSetupAdapter`、`createEnvPatchedAccountSetupAdapter`、`createSetupInputPresenceValidator`、`noteChannelLookupFailure`、`noteChannelLookupSummary`、`promptResolvedAllowFrom`、`splitSetupEntries`、`createAllowlistSetupWizardProxy`、`createDelegatedSetupWizardProxy` |
| `plugin-sdk/setup-adapter-runtime` | 环境感知的账户设置适配器                                     | `createEnvPatchedAccountSetupAdapter`                                                                                                                                                                                                                                                        |
| `plugin-sdk/setup-tools`           | 设置/安装 CLI/归档/文档助手                                  | `formatCliCommand`、`detectBinary`、`extractArchive`、`resolveBrewExecutable`、`formatDocsLink`、`CONFIG_DIR`                                                                                                                                                                                |

当你想要完整的共享设置工具箱，包括配置补丁助手如 `moveSingleAccountChannelSectionToDefaultAccount(...)` 时，使用更广泛的 `plugin-sdk/setup` 接缝。

设置补丁适配器在导入时保持热路径安全。它们的捆绑单账户提升契约表面查找是惰性的，因此导入 `plugin-sdk/setup-runtime` 不会在实际使用适配器之前急切加载捆绑契约表面发现。

### 通道拥有的单账户提升

当通道从单账户顶级配置升级到 `channels.<id>.accounts.*` 时，默认共享行为是将提升的账户范围值移动到 `accounts.default`。

捆绑通道可以通过其设置契约表面缩小或覆盖该提升：

- `singleAccountKeysToMove`：应移动到提升账户的额外顶级键
- `namedAccountPromotionKeys`：当命名账户已存在时，只有这些键移动到提升账户；共享策略/传递键保持在通道根
- `resolveSingleAccountPromotionTarget(...)`：选择哪个现有账户接收提升值

Matrix 是当前的捆绑示例。如果恰好存在一个命名的 Matrix 账户，或者如果 `defaultAccount` 指向现有的非规范键（如 `Ops`），提升会保留该账户，而不是创建新的 `accounts.default` 条目。

## 配置架构

插件配置根据你清单中的 JSON Schema 进行验证。用户通过以下方式配置插件：

```json5
{
  plugins: {
    entries: {
      "my-plugin": {
        config: {
          webhookSecret: "abc123",
        },
      },
    },
  },
}
```

你的插件在注册期间将此配置作为 `api.pluginConfig` 接收。

对于通道特定配置，请使用通道配置部分：

```json5
{
  channels: {
    "my-channel": {
      token: "bot-token",
      allowFrom: ["user1", "user2"],
    },
  },
}
```

### 构建通道配置架构

使用 `openclaw/plugin-sdk/core` 中的 `buildChannelConfigSchema` 将 Zod 架构转换为 OpenClaw 验证的 `ChannelConfigSchema` 包装器：

```typescript
import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/core";

const accountSchema = z.object({
  token: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  accounts: z.object({}).catchall(z.any()).optional(),
  defaultAccount: z.string().optional(),
});

const configSchema = buildChannelConfigSchema(accountSchema);
```

## 设置向导

通道插件可以为 `openclaw onboard` 提供交互式设置向导。向导是 `ChannelPlugin` 上的 `ChannelSetupWizard` 对象：

```typescript
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";

const setupWizard: ChannelSetupWizard = {
  channel: "my-channel",
  status: {
    configuredLabel: "Connected",
    unconfiguredLabel: "Not configured",
    resolveConfigured: ({ cfg }) => Boolean((cfg.channels as any)?.["my-channel"]?.token),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: "my-channel",
      credentialLabel: "Bot token",
      preferredEnvVar: "MY_CHANNEL_BOT_TOKEN",
      envPrompt: "Use MY_CHANNEL_BOT_TOKEN from environment?",
      keepPrompt: "Keep current token?",
      inputPrompt: "Enter your bot token:",
      inspect: ({ cfg, accountId }) => {
        const token = (cfg.channels as any)?.["my-channel"]?.token;
        return {
          accountConfigured: Boolean(token),
          hasConfiguredValue: Boolean(token),
        };
      },
    },
  ],
};
```

`ChannelSetupWizard` 类型支持 `credentials`、`textInputs`、`dmPolicy`、`allowFrom`、`groupAccess`、`prepare`、`finalize` 等。请参阅捆绑插件包（例如 Discord 插件 `src/channel.setup.ts`）以获取完整示例。

对于只需要标准 `note -> prompt -> parse -> merge -> patch` 流程的 DM 允许列表提示，首选来自 `openclaw/plugin-sdk/setup` 的共享设置助手：`createPromptParsedAllowFromForAccount(...)`、`createTopLevelChannelParsedAllowFromPrompt(...)` 和 `createNestedChannelParsedAllowFromPrompt(...)`。

对于仅因标签、分数和可选额外行而不同的通道设置状态块，首选来自 `openclaw/plugin-sdk/setup` 的 `createStandardChannelSetupStatus(...)`，而不是在每个插件中手动滚动相同的 `status` 对象。

对于仅应在特定上下文中出现的可选设置界面，使用来自 `openclaw/plugin-sdk/channel-setup` 的 `createOptionalChannelSetupSurface`：

```typescript
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";

const setupSurface = createOptionalChannelSetupSurface({
  channel: "my-channel",
  label: "My Channel",
  npmSpec: "@myorg/openclaw-my-channel",
  docsPath: "/channels/my-channel",
});
// Returns { setupAdapter, setupWizard }
```

`plugin-sdk/channel-setup` 还暴露低级的 `createOptionalChannelSetupAdapter(...)` 和 `createOptionalChannelSetupWizard(...)` 构建器，当你只需要该可选安装界面的一半时。

生成的可选适配器/向导在实际配置写入时失败关闭。它们在 `validateInput`、`applyAccountConfig` 和 `finalize` 中重用一条安装必需消息，并在设置 `docsPath` 时附加文档链接。

对于二进制支持的设置 UI，首选共享的委托助手，而不是将相同的二进制/状态胶水复制到每个通道：

- `createDetectedBinaryStatus(...)` 用于仅因标签、提示、分数和二进制检测而不同的状态块
- `createCliPathTextInput(...)` 用于基于路径的文本输入
- `createDelegatedSetupWizardStatusResolvers(...)`、`createDelegatedPrepare(...)`、`createDelegatedFinalize(...)` 和 `createDelegatedResolveConfigured(...)` 当 `setupEntry` 需要懒惰地转发到更重的完整向导时
- `createDelegatedTextInputShouldPrompt(...)` 当 `setupEntry` 只需要委托 `textInputs[*].shouldPrompt` 决策时

## 发布和安装

**外部插件：** 发布到 [ClawHub](/tools/clawhub) 或 npm，然后安装：

```bash
openclaw plugins install @myorg/openclaw-my-plugin
```

OpenClaw 首先尝试 ClawHub，然后自动回退到 npm。你也可以明确强制 ClawHub：

```bash
openclaw plugins install clawhub:@myorg/openclaw-my-plugin   # ClawHub only
```

没有匹配的 `npm:` 覆盖。当你想要 ClawHub 回退后的 npm 路径时，使用正常的 npm 包规范：

```bash
openclaw plugins install @myorg/openclaw-my-plugin
```

**仓库内插件：** 放在捆绑插件工作区树下，它们会在构建期间自动被发现。

**用户可以安装：**

```bash
openclaw plugins install <package-name>
```

<Info>
  对于 npm 源安装，`openclaw plugins install` 运行 `npm install --ignore-scripts`（无生命周期脚本）。保持插件依赖树为纯 JS/TS，避免需要 `postinstall` 构建的包。
</Info>

## 相关

- [SDK 入口点](/plugins/sdk-entrypoints) -- `definePluginEntry` 和 `defineChannelPluginEntry`
- [插件清单](/plugins/manifest) -- 完整清单架构参考
- [构建插件](/plugins/building-plugins) -- 分步入门指南
