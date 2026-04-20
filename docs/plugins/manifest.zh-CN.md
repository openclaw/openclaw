---
summary: "插件清单 + JSON 模式要求（严格的配置验证）"
read_when:
  - 你正在构建 OpenClaw 插件
  - 你需要提供插件配置模式或调试插件验证错误
title: "插件清单"
---

# 插件清单 (openclaw.plugin.json)

本页面仅适用于**原生 OpenClaw 插件清单**。

对于兼容的捆绑布局，请参阅 [插件捆绑包](/plugins/bundles)。

兼容的捆绑格式使用不同的清单文件：

- Codex 捆绑包：`.codex-plugin/plugin.json`- Claude 捆绑包：`.claude-plugin/plugin.json`或默认的 Claude 组件
  没有清单的布局
- Cursor 捆绑包：`.cursor-plugin/plugin.json`OpenClaw 也会自动检测这些捆绑布局，但它们不会针对此处描述的`openclaw.plugin.json`模式进行验证。

对于兼容的捆绑包，OpenClaw 当前读取捆绑包元数据以及声明的
技能根、Claude 命令根、Claude 捆绑包`settings.json`默认值、
Claude 捆绑包 LSP 默认值，以及当布局匹配
OpenClaw 运行时期望时支持的钩子包。

每个原生 OpenClaw 插件**必须**在
**插件根目录**中提供一个`openclaw.plugin.json`文件。OpenClaw 使用此清单来验证配置
**无需执行插件代码**。缺失或无效的清单被视为
插件错误并阻止配置验证。

请参阅完整的插件系统指南：[插件](/tools/plugin)。
有关原生能力模型和当前外部兼容性指导：
[能力模型](/plugins/architecture#public-capability-model)。

## 此文件的作用`openclaw.plugin.json`是 OpenClaw 在加载插件代码之前读取的元数据

使用它用于：

- 插件标识
- 配置验证
- 认证和引导元数据，这些元数据应在不启动插件
  运行时的情况下可用
- 控制平面表面可以在运行时
  加载之前检查的廉价激活提示
- 引导/引导表面可以在
  运行时加载之前检查的廉价设置描述符
- 应在插件运行时加载之前解析的别名和自动启用元数据
- 应在运行时加载之前自动激活
  插件的简写模型系列所有权元数据
- 用于捆绑兼容接线和
  契约覆盖的静态能力所有权快照
- 共享`openclaw qa`主机可以检查的廉价 QA 运行器元数据
  在插件运行时加载之前
- 应合并到目录和验证
  表面而不加载运行时的通道特定配置元数据
- 配置 UI 提示

不要将其用于：

- 注册运行时行为
- 声明代码入口点
- npm 安装元数据

这些属于你的插件代码和`package.json`。

## 最小示例```json

{
"id": "voice-call",
"configSchema": {
"type": "object",
"additionalProperties": false,
"properties": {}
}
}`## 丰富示例`json
{
"id": "openrouter",
"name": "OpenRouter",
"description": "OpenRouter provider plugin",
"version": "1.0.0",
"providers": ["openrouter"],
"modelSupport": {
"modelPrefixes": ["router-"]
},
"providerEndpoints": [
{
"endpointClass": "xai-native",
"hosts": ["api.x.ai"]
}
],
"cliBackends": ["openrouter-cli"],
"syntheticAuthRefs": ["openrouter-cli"],
"providerAuthEnvVars": {
"openrouter": ["OPENROUTER_API_KEY"]
},
"providerAuthAliases": {
"openrouter-coding": "openrouter"
},
"channelEnvVars": {
"openrouter-chatops": ["OPENROUTER_CHATOPS_TOKEN"]
},
"providerAuthChoices": [
{
"provider": "openrouter",
"method": "api-key",
"choiceId": "openrouter-api-key",
"choiceLabel": "OpenRouter API key",
"groupId": "openrouter",
"groupLabel": "OpenRouter",
"optionKey": "openrouterApiKey",
"cliFlag": "--openrouter-api-key",
"cliOption": "--openrouter-api-key `key`",
"cliDescription": "OpenRouter API key",
"onboardingScopes": ["text-inference"]
}
],
"uiHints": {
"apiKey": {
"label": "API key",
"placeholder": "sk-or-v1-",
"sensitive": true
}
},
"configSchema": {
"type": "object",
"additionalProperties": false,
"properties": {
"apiKey": {
"type": "string"
}
}
}
}```## 顶级字段参考

| 字段 | 必需 | 类型 | 含义 |

|---------------------------------------------- | ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------|

|`id`| 是 |`string`| 规范插件 ID。这是在`plugins.entries.<id>`中使用的 ID。 |

|`configSchema`| 是 |`object`| 此插件配置的内联 JSON 模式。 |

|`enabledByDefault`| 否 |`true`| 将捆绑插件标记为默认启用。省略它，或设置任何非`true`值，以使插件默认禁用。 |

|`legacyPluginIds`| 否 |`string[]`| 规范化为此规范插件 ID 的遗留 ID。 |

|`autoEnableWhenConfiguredProviders`| 否 |`string[]`| 当认证、配置或模型引用提及它们时应自动启用此插件的提供商 ID。 |

|`kind`| 否 |`"memory"``"context-engine"`| 声明由`plugins.slots.*`使用的独占插件类型。 |

|`channels`| 否 |`string[]`| 此插件拥有的通道 ID。用于发现和配置验证。 |

|`providers`| 否 |`string[]`| 此插件拥有的提供商 ID。 |

|`modelSupport`| 否 |`object`| 清单拥有的简写模型系列元数据，用于在运行时之前自动加载插件。 |

|`providerEndpoints`| 否 |`object[]`| 清单拥有的提供商路由的端点主机/baseUrl 元数据，核心必须在提供商运行时加载之前对其进行分类。 |

|`cliBackends`| 否 |`string[]`| 此插件拥有的 CLI 推理后端 ID。用于从显式配置引用启动自动激活。 |

|`syntheticAuthRefs`| 否 |`string[]`| 提供商或 CLI 后端引用，其插件拥有的合成认证钩子应在运行时加载之前的冷模型发现期间进行探测。 |

|`nonSecretAuthMarkers`| 否 |`string[]`| 捆绑插件拥有的占位符 API 密钥值，表示非秘密的本地、OAuth 或环境凭证状态。 |

|`commandAliases`| 否 |`object[]`| 此插件拥有的命令名称，用户可能会错误地将其放在`plugins.allow`中或尝试作为根 CLI 命令运行。OpenClaw |

|`providerAuthEnvVars`| 否 |`Record<string, string[]>`| OpenClaw 可以在不加载插件代码的情况下检查的廉价提供商认证环境元数据。 |

|`providerAuthAliases`| 否 |`Record<string, string>`| 应重用另一个提供商 ID 进行认证查找的提供商 ID，例如共享基础提供商 API 密钥和认证配置文件的编码提供商。 |

|`channelEnvVars`| 否 |`Record<string, string[]>`| OpenClaw 可以在不加载插件代码的情况下检查的廉价通道环境元数据。用于环境驱动的通道设置或通用启动/配置助手应看到的认证表面。 |

|`providerAuthChoices`| 否 |`object[]`| 用于引导选择器、首选提供商解析和简单 CLI 标志接线的廉价认证选择元数据。 |

|`activation`| 否 |`object`| 提供商、命令、通道、路由和能力触发加载的廉价激活提示。仅元数据；插件运行时仍然拥有实际行为。 |

|`setup`| 否 |`object`| 发现和设置表面可以在不加载插件运行时的情况下检查的廉价设置/引导描述符。 |

|`qaRunners`| 否 |`object[]`| 共享`openclaw qa`主机在插件运行时加载之前使用的廉价 QA 运行器描述符。 |

|`contracts`| 否 |`object`| 语音、实时转录、实时语音、媒体理解、图像生成、音乐生成、视频生成、网络获取、网络搜索和工具所有权的静态捆绑能力快照。 |

|`channelConfigs`| 否 |`Record<string, object>`| 清单拥有的通道配置元数据，在运行时加载之前合并到发现和验证表面。 |

|`skills`| 否 |`string[]`| 要加载的技能目录，相对于插件根目录。 |

|`name`| 否 |`string`| 人类可读的插件名称。 |

|`description`| 否 |`string`| 插件表面中显示的简短摘要。 |

|`version`| 否 |`string`| 信息性插件版本。 |

|`uiHints`| 否 |`Record<string, object>`| 配置字段的 UI 标签、占位符和敏感性提示。 |

## providerAuthChoices 参考

每个`providerAuthChoices`条目描述一个引导或认证选择。
OpenClaw 在提供商运行时加载之前读取此信息。

| 字段 | 必需 | 类型 | 含义 |

|--------------------- | ---- | --------------------------------------------- | ---------------------------------------------------------------------|

|`provider`| 是 |`string`| 此选择所属的提供商 ID。 |

|`method`| 是 |`string`| 要调度到的认证方法 ID。 |

|`choiceId`| 是 |`string`| 引导和 CLI 流程使用的稳定认证选择 ID。 |

|`choiceLabel`| 否 |`string`| 用户面向的标签。如果省略，OpenClaw 回退到`choiceId`。 |

|`choiceHint`| 否 |`string`| 选择器的简短帮助文本。 |

|`assistantPriority`| 否 |`number`| 较低的值在助手驱动的交互式选择器中排序更早。 |

|`assistantVisibility`| 否 |`"visible"``"manual-only"`| 从助手选择器中隐藏选择，同时仍允许手动 CLI 选择。 |

|`deprecatedChoiceIds`| 否 |`string[]`| 应将用户重定向到此替换选择的遗留选择 ID。 |

|`groupId`| 否 |`string`| 用于对相关选择进行分组的可选组 ID。 |

|`groupLabel`| 否 |`string`| 该组的用户面向标签。 |

|`groupHint`| 否 |`string`| 该组的简短帮助文本。 |

|`optionKey`| 否 |`string`| 简单单标志认证流程的内部选项键。 |

|`cliFlag`| 否 |`string`| CLI 标志名称，例如`--openrouter-api-key`。 |

|`cliOption`| 否 |`string`| 完整的 CLI 选项形状，例如`--openrouter-api-key key`。 |

|`cliDescription`| 否 |`string`| CLI 帮助中使用的描述。 |

|`onboardingScopes`| 否 |`Array<"text-inference"  "image-generation">`| 此选择应出现在哪些引导表面中。如果省略，默认为`["text-inference"]`。 |

## commandAliases 参考

当插件拥有用户可能会
错误地放在`plugins.allow`中或尝试作为根 CLI 命令运行的运行时命令名称时，使用`commandAliases`。OpenClaw
使用此元数据进行诊断，无需导入插件运行时代码。`json
{
  "commandAliases": [
    {
      "name": "dreaming",
      "kind": "runtime-slash",
      "cliCommand": "memory"
    }
  ]
}`| 字段 | 必需 | 类型 | 含义 |

|------------ | ---- | ----------------- | ----------------------------------------------|

|`name`| 是 |`string`| 属于此插件的命令名称。 |

|`kind`| 否 |`"runtime-slash"`| 将别名标记为聊天斜杠命令，而不是根 CLI 命令。 |

|`cliCommand`| 否 |`string`| 相关的根 CLI 命令，用于 CLI 操作（如果存在）。 |

## activation 参考

当插件可以廉价地声明哪些控制平面事件
应在以后激活它时，使用`activation`。

## qaRunners 参考

当插件在共享`openclaw qa`根目录下提供一个或多个传输运行器时，使用`qaRunners`。保持此元数据廉价且静态；插件
运行时仍然通过轻量级`runtime-api.ts`表面拥有实际的 CLI 注册，该表面导出`qaRunnerCliRegistrations`。`json
{
  "qaRunners": [
    {
      "commandName": "matrix",
      "description": "Run the Docker-backed Matrix live QA lane against a disposable homeserver"
    }
  ]
}`| 字段 | 必需 | 类型 | 含义 |

|------------- | ---- | -------- | ------------------------------------------------|

|`commandName`| 是 |`string`| 安装在`openclaw qa`下的子命令，例如`matrix`。 |

|`description`| 否 |`string`| 当共享主机需要存根命令时使用的回退帮助文本。 |

此块仅为元数据。它不注册运行时行为，也不
替换`register(...)`、`setupEntry`或其他运行时/插件入口点。
当前消费者将其用作更广泛的插件加载之前的缩小提示，因此
缺少激活元数据通常只会影响性能；在遗留清单所有权回退仍然存在的情况下，它不应
改变正确性。`json
{
  "activation": {
    "onProviders": ["openai"],
    "onCommands": ["models"],
    "onChannels": ["web"],
    "onRoutes": ["gateway-webhook"],
    "onCapabilities": ["provider", "tool"]
  }
}`| 字段 | 必需 | 类型 | 含义 |

|---------------- | ---- | ---------------------------------------------- | ------------------------------------|

|`onProviders`| 否 |`string[]`| 当请求时应激活此插件的提供商 ID。 |

|`onCommands`| 否 |`string[]`| 应激活此插件的命令 ID。 |

|`onChannels`| 否 |`string[]`| 应激活此插件的通道 ID。 |

|`onRoutes`| 否 |`string[]`| 应激活此插件的路由类型。 |

|`onCapabilities`| 否 |`Array<"provider"  "channel"  "tool"  "hook">`| 控制平面激活规划使用的广泛能力提示。 |

当前实时消费者：

- 命令触发的 CLI 规划回退到遗留`commandAliases[].cliCommand`或`commandAliases[].name`- 通道触发的设置/通道规划在缺少显式通道激活元数据时回退到遗留`channels[]`所有权
- 提供商触发的设置/运行时规划在缺少显式提供商
  激活元数据时回退到遗留`providers[]`和顶级`cliBackends[]`所有权

## setup 参考

当设置和引导表面需要在运行时加载之前获得廉价的插件拥有元数据时，使用`setup`。`json
{
  "setup": {
    "providers": [
      {
        "id": "openai",
        "authMethods": ["api-key"],
        "envVars": ["OPENAI_API_KEY"]
      }
    ],
    "cliBackends": ["openai-cli"],
    "configMigrations": ["legacy-openai-auth"],
    "requiresRuntime": false
  }
}`顶级`cliBackends`保持有效，并继续描述 CLI 推理
后端。`setup.cliBackends`是控制平面/设置流程的特定于设置的描述符表面，
应保持仅元数据。

当存在时，`setup.providers`和`setup.cliBackends`是设置发现的首选
描述符优先查找表面。如果描述符仅
缩小候选插件范围，并且设置仍然需要更丰富的设置时运行时
钩子，则设置`requiresRuntime: true`并保持`setup-api`作为
回退执行路径。

因为设置查找可以执行插件拥有的`setup-api`代码，所以标准化`setup.providers[].id`和`setup.cliBackends[]`值必须在
发现的插件中保持唯一。模糊所有权会失败而不是从发现顺序中选择
获胜者。

### setup.providers 参考

| 字段 | 必需 | 类型 | 含义 |

|------------- | ---- | ---------- | ---------------------------------------------------------|

|`id`| 是 |`string`| 设置或引导期间暴露的提供商 ID。保持标准化 ID 全局唯一。 |

|`authMethods`| 否 |`string[]`| 此提供商支持的设置/认证方法 ID，无需加载完整运行时。 |

|`envVars`| 否 |`string[]`| 通用设置/状态表面可以在插件运行时加载之前检查的环境变量。 |

### setup 字段

| 字段 | 必需 | 类型 | 含义 |

|------------------ | ---- | ---------- | ---------------------------------------------------------------|

|`providers`| 否 |`object[]`| 设置和引导期间暴露的提供商设置描述符。 |

|`cliBackends`| 否 |`string[]`| 用于描述符优先设置查找的设置时后端 ID。保持标准化 ID 全局唯一。 |

|`configMigrations`| 否 |`string[]`| 此插件设置表面拥有的配置迁移 ID。 |

|`requiresRuntime`| 否 |`boolean`| 描述符查找后设置是否仍需要`setup-api`执行。 |

## uiHints 参考`uiHints`是从配置字段名称到小型渲染提示的映射。```json

{
"uiHints": {
"apiKey": {
"label": "API key",
"help": "Used for OpenRouter requests",
"placeholder": "sk-or-v1-",
"sensitive": true
}
}
}```每个字段提示可以包括：

| 字段 | 类型 | 含义 |

|------------- | ---------- | ------------------------|

|`label`|`string`| 用户面向的字段标签。 |

|`help`|`string`| 简短的帮助文本。 |

|`tags`|`string[]`| 可选的 UI 标签。 |

|`advanced`|`boolean`| 将字段标记为高级。 |

|`sensitive`|`boolean`| 将字段标记为秘密或敏感。 |

|`placeholder`|`string`| 表单输入的占位文本。 |

## contracts 参考

仅对 OpenClaw 可以
在不导入插件运行时的情况下读取的静态能力所有权元数据使用`contracts`。`json
{
  "contracts": {
    "speechProviders": ["openai"],
    "realtimeTranscriptionProviders": ["openai"],
    "realtimeVoiceProviders": ["openai"],
    "mediaUnderstandingProviders": ["openai", "openai-codex"],
    "imageGenerationProviders": ["openai"],
    "videoGenerationProviders": ["qwen"],
    "webFetchProviders": ["firecrawl"],
    "webSearchProviders": ["gemini"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}`每个列表都是可选的：

| 字段 | 类型 | 含义 |

|-------------------------------- | ---------- | --------------------------------------------|

|`speechProviders`|`string[]`| 此插件拥有的语音提供商 ID。 |

|`realtimeTranscriptionProviders`|`string[]`| 此插件拥有的实时转录提供商 ID。 |

|`realtimeVoiceProviders`|`string[]`| 此插件拥有的实时语音提供商 ID。 |

|`mediaUnderstandingProviders`|`string[]`| 此插件拥有的媒体理解提供商 ID。 |

|`imageGenerationProviders`|`string[]`| 此插件拥有的图像生成提供商 ID。 |

|`videoGenerationProviders`|`string[]`| 此插件拥有的视频生成提供商 ID。 |

|`webFetchProviders`|`string[]`| 此插件拥有的网络获取提供商 ID。 |

|`webSearchProviders`|`string[]`| 此插件拥有的网络搜索提供商 ID。 |

|`tools`|`string[]`| 此插件拥有的代理工具名称，用于捆绑契约检查。 |

## channelConfigs 参考

当通道插件需要在
运行时加载之前获得廉价的配置元数据时，使用`channelConfigs`。`json
{
  "channelConfigs": {
    "matrix": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "homeserverUrl": { "type": "string" }
        }
      },
      "uiHints": {
        "homeserverUrl": {
          "label": "Homeserver URL",
          "placeholder": "<https://matrix.example.com>"
        }
      },
      "label": "Matrix",
      "description": "Matrix homeserver connection",
      "preferOver": ["matrix-legacy"]
    }
  }
}`每个通道条目可以包括：

| 字段 | 类型 | 含义 |

|------------- | ------------------------ | ------------------------------------------------------------|

|`schema`|`object`|`channels.<id>`的 JSON 模式。每个声明的通道配置条目都必需。 |

|`uiHints`|`Record<string, object>`| 该通道配置部分的可选 UI 标签/占位符/敏感提示。 |

|`label`|`string`| 当运行时元数据未就绪时，合并到选择器和检查表面的通道标签。 |

|`description`|`string`| 检查和目录表面的简短通道描述。 |

|`preferOver`|`string[]`| 此通道应在选择表面中超越的遗留或低优先级插件 ID。 |

## modelSupport 参考

当 OpenClaw 应从
简写模型 ID（如`gpt-5.4`或`claude-sonnet-4.6`）推断你的提供商插件时，使用`modelSupport`，而无需插件运行时
加载。`json
{
  "modelSupport": {
    "modelPrefixes": ["gpt-", "o1", "o3", "o4"],
    "modelPatterns": ["^computer-use-preview"]
  }
}`OpenClaw 应用此优先级：

- 显式`provider/model`引用使用拥有的`providers`清单元数据 -`modelPatterns`优于`modelPrefixes`- 如果一个非捆绑插件和一个捆绑插件都匹配，非捆绑
  插件获胜
- 剩余的歧义被忽略，直到用户或配置指定提供商

字段：

| 字段 | 类型 | 含义 |

|--------------- | ---------- | ----------------------------------------------------|

|`modelPrefixes`|`string[]`| 与简写模型 ID 的`startsWith`匹配的前缀。 |

|`modelPatterns`|`string[]`| 配置文件后缀移除后与简写模型 ID 匹配的正则表达式源。 |

遗留的顶级能力键已弃用。使用`openclaw doctor --fix`移动`speechProviders`、`realtimeTranscriptionProviders`、`realtimeVoiceProviders`、`mediaUnderstandingProviders`、`imageGenerationProviders`、`videoGenerationProviders`、`webFetchProviders`和`webSearchProviders`到`contracts`下；正常
清单加载不再将这些顶级字段视为能力
所有权。

## 清单与 package.json

这两个文件服务于不同的工作：

如果你不确定元数据的归属，请使用此规则：

- 如果 OpenClaw 必须在加载插件代码之前知道它，将其放在`openclaw.plugin.json`中
- 如果它与打包、入口文件或 npm 安装行为有关，将其放在`package.json`中

### 影响发现的 package.json 字段

一些运行前插件元数据有意位于`package.json`中的`openclaw`块下，而不是`openclaw.plugin.json`中。

重要示例：

|`openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen`| 允许仅设置通道表面在启动期间在完整通道插件之前加载。 |`openclaw.install.minHostVersion`在安装和清单
注册表加载期间强制执行。无效值被拒绝；较新但有效的值在较旧的主机上跳过
插件。`openclaw.install.allowInvalidConfigRecovery`有意狭窄。它不
使任意损坏的配置可安装。今天它只允许安装
流程从特定的陈旧捆绑插件升级失败中恢复，例如缺少捆绑插件路径或该相同
捆绑插件的陈旧`channels.<id>`条目。不相关的配置错误仍然阻止安装并将操作员发送到`openclaw doctor --fix`。`openclaw.channel.persistedAuthState`是一个小检查器
模块的包元数据：`json
{
  "openclaw": {
    "channel": {
      "id": "whatsapp",
      "persistedAuthState": {
        "specifier": "./auth-presence",
        "exportName": "hasAnyWhatsAppAuth"
      }
    }
  }
}`当设置、医生或配置状态流程需要在完整通道插件加载之前进行廉价的是/否认证
探测时使用它。目标导出应该是一个小
函数，仅读取持久状态；不要通过完整的
通道运行时桶路由它。`openclaw.channel.configuredState`对于廉价的仅环境
配置检查遵循相同的形状：`json
{
  "openclaw": {
    "channel": {
      "id": "telegram",
      "configuredState": {
        "specifier": "./configured-state",
        "exportName": "hasTelegramConfiguredState"
      }
    }
  }
}`当通道可以从环境或其他小的
非运行时输入回答配置状态时使用它。如果检查需要完整的配置解析或真实
通道运行时，请将该逻辑保留在插件`config.hasConfiguredState`钩子中。

## JSON 模式要求

- **每个插件必须提供 JSON 模式**，即使它不接受任何配置。
- 空模式是可接受的（例如，`{ "type": "object", "additionalProperties": false }`）。
- 模式在配置读写时验证，而不是在运行时。

## 验证行为

- 未知的`channels.*`键是**错误**，除非通道 ID 由
  插件清单声明。-`plugins.entries.<id>`、`plugins.allow`、`plugins.deny`和`plugins.slots.*`必须引用**可发现**的插件 ID。未知 ID 是**错误**。
- 如果插件已安装但具有损坏或缺失的清单或模式，
  验证失败，医生报告插件错误。
- 如果插件配置存在但插件**被禁用**，配置被保留，并且
  在医生 + 日志中显示**警告**。

有关完整的`plugins.*`模式，请参阅 [配置参考](/gateway/configuration)。

## 注意事项

- **原生 OpenClaw 插件需要清单**，包括本地文件系统加载。
- 运行时仍会单独加载插件模块；清单仅用于
  发现 + 验证。
- 原生清单使用 JSON5 解析，因此只要最终值仍然是对象，就接受注释、尾随逗号和
  未引用的键。
- 清单加载器仅读取记录的清单字段。避免在此处添加
  自定义顶级键。-`providerAuthEnvVars`是认证探测、环境标记
  验证和类似提供商认证表面的廉价元数据路径，这些表面不应仅为了检查环境名称而启动插件
  运行时。-`providerAuthAliases`允许提供商变体重用另一个提供商的认证
  环境变量、认证配置文件、基于配置的认证和 API 密钥引导选择
  而无需在核心中硬编码该关系。-`providerEndpoints`允许提供商插件拥有简单的端点主机/baseUrl
  匹配元数据。仅用于核心已经支持的端点类；
  插件仍然拥有运行时行为。-`syntheticAuthRefs`是提供商拥有的合成
  认证钩子的廉价元数据路径，这些钩子必须在运行时
  注册表存在之前对冷模型发现可见。仅列出其运行时提供商或 CLI 后端实际
  实现`resolveSyntheticAuth`的引用。-`nonSecretAuthMarkers`是捆绑插件拥有的
  占位符 API 密钥（如本地、OAuth 或环境凭证标记）的廉价元数据路径。
  核心将这些视为认证显示和秘密审计的非秘密，而无需
  硬编码拥有的提供商。-`channelEnvVars`是 shell-env 回退、设置
  提示和类似通道表面的廉价元数据路径，这些表面不应仅为了检查环境名称而启动插件运行时。-`providerAuthChoices`是认证选择选择器、`--auth-choice`解析、首选提供商映射和简单引导
  CLI 标志注册的廉价元数据路径，在提供商运行时加载之前。对于需要提供商代码的运行时向导
  元数据，请参阅
  [提供商运行时钩子](/plugins/architecture#provider-runtime-hooks)。
- 独占插件类型通过`plugins.slots.*`选择。-`kind: "memory"`由`plugins.slots.memory`选择。-`kind: "context-engine"`由`plugins.slots.contextEngine`选择
  （默认：内置`legacy`）。-`channels`、`providers`、`cliBackends`和`skills`在插件
  不需要它们时可以省略。
- 如果你的插件依赖于原生模块，请记录构建步骤和任何
  包管理器允许列表要求（例如，pnpm`allow-build-scripts`-`pnpm rebuild <package>`）。

## 相关

- [构建插件](/plugins/building-plugins) — 插件入门
- [插件架构](/plugins/architecture) — 内部架构
- [SDK 概览](/plugins/sdk-overview) — 插件 SDK 参考
