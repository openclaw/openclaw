---
title: "代理执行器插件"
sidebarTitle: "代理执行器"
summary: "用于替换低级别嵌入式代理执行器的实验性 SDK 接口"
read_when:
  - 你正在更改嵌入式代理运行时或执行器注册表
  - 你正在从捆绑或受信任的插件注册代理执行器
  - 你需要了解 Codex 插件如何与模型提供商相关联
---

# 代理执行器插件

**代理执行器**是一个准备好的 OpenClaw 代理轮次的低级执行器。它不是模型提供商，不是通道，也不是工具注册表。

仅对捆绑或受信任的原生插件使用此接口。该合约仍然是实验性的，因为参数类型故意镜像当前的嵌入式运行器。

## 何时使用执行器

当模型系列拥有自己的原生会话运行时，且正常的 OpenClaw 提供商传输是错误的抽象时，注册代理执行器。

示例：

- 拥有线程和压缩的原生编码代理服务器
- 必须流式传输原生计划/推理/工具事件的本地 CLI 或守护进程
- 需要除 OpenClaw 会话记录外自己的恢复 ID 的模型运行时

**不要**仅仅为了添加新的 LLM API 而注册执行器。对于普通的 HTTP 或 WebSocket 模型 API，请构建 [提供商插件](/plugins/sdk-provider-plugins)。

## 核心仍然拥有的内容

在选择执行器之前，OpenClaw 已经解析了：

- 提供商和模型
- 运行时认证状态
- 思考级别和上下文预算
- OpenClaw 记录/会话文件
- 工作区、沙盒和工具策略
- 通道回复回调和流回调
- 模型回退和实时模型切换策略

这种分离是有意的。执行器运行准备好的尝试；它不会选择提供商、替换通道传递或静默切换模型。

## 注册执行器

**导入：** `openclaw/plugin-sdk/agent-harness`

```typescript
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const myHarness: AgentHarness = {
  id: "my-harness",
  label: "My native agent harness",

  supports(ctx) {
    return ctx.provider === "my-provider"
      ? { supported: true, priority: 100 }
      : { supported: false };
  },

  async runAttempt(params) {
    // 启动或恢复你的原生线程。
    // 使用 params.prompt, params.tools, params.images, params.onPartialReply,
    // params.onAgentEvent 和其他准备好的尝试字段。
    return await runMyNativeTurn(params);
  },
};

export default definePluginEntry({
  id: "my-native-agent",
  name: "My Native Agent",
  description: "Runs selected models through a native agent daemon.",
  register(api) {
    api.registerAgentHarness(myHarness);
  },
});
```

## 选择策略

OpenClaw 在提供商/模型解析后选择执行器：

1. `OPENCLAW_AGENT_RUNTIME=<id>` 强制使用具有该 id 的已注册执行器。
2. `OPENCLAW_AGENT_RUNTIME=pi` 强制使用内置的 PI 执行器。
3. `OPENCLAW_AGENT_RUNTIME=auto` 询问已注册的执行器是否支持解析的提供商/模型。
4. 如果没有匹配的已注册执行器，OpenClaw 使用 PI，除非 PI 回退被禁用。

强制插件执行器失败表现为运行失败。在 `auto` 模式下，当选定的插件执行器在轮次产生副作用之前失败时，OpenClaw 可能会回退到 PI。设置 `OPENCLAW_AGENT_HARNESS_FALLBACK=none` 或 `embeddedHarness.fallback: "none"` 使该回退成为硬失败。

捆绑的 Codex 插件将 `codex` 注册为其执行器 id。核心将其视为普通的插件执行器 id；Codex 特定的别名属于插件或操作员配置，而不是共享的运行时选择器。

## 提供商加执行器配对

大多数执行器还应该注册一个提供商。提供商使模型引用、认证状态、模型元数据和 `/model` 选择对 OpenClaw 的其余部分可见。然后执行器在 `supports(...)` 中声明该提供商。

捆绑的 Codex 插件遵循此模式：

- 提供商 id：`codex`
- 用户模型引用：`codex/gpt-5.4`、`codex/gpt-5.2` 或 Codex 应用服务器返回的其他模型
- 执行器 id：`codex`
- 认证：合成提供商可用性，因为 Codex 执行器拥有原生 Codex 登录/会话
- 应用服务器请求：OpenClaw 向 Codex 发送裸模型 id，让执行器与原生应用服务器协议通信

Codex 插件是附加的。普通的 `openai/gpt-*` 引用仍然是 OpenAI 提供商引用，并继续使用正常的 OpenClaw 提供商路径。当你想要 Codex 管理的认证、Codex 模型发现、原生线程和 Codex 应用服务器执行时，选择 `codex/gpt-*`。`/model` 可以在 Codex 应用服务器返回的 Codex 模型之间切换，而不需要 OpenAI 提供商凭据。

有关操作员设置、模型前缀示例和仅 Codex 配置，请参阅 [Codex 执行器](/plugins/codex-harness)。

OpenClaw 需要 Codex 应用服务器 `0.118.0` 或更新版本。Codex 插件检查应用服务器初始化握手，并阻止较旧或未版本化的服务器，因此 OpenClaw 只运行在它已经测试过的协议接口上。

### 原生 Codex 执行器模式

捆绑的 `codex` 执行器是嵌入式 OpenClaw 代理轮次的原生 Codex 模式。首先启用捆绑的 `codex` 插件，如果你的配置使用限制性允许列表，请在 `plugins.allow` 中包含 `codex`。它与 `openai-codex/*` 不同：

- `openai-codex/*` 通过正常的 OpenClaw 提供商路径使用 ChatGPT/Codex OAuth。
- `codex/*` 使用捆绑的 Codex 提供商，并通过 Codex 应用服务器路由轮次。

当此模式运行时，Codex 拥有原生线程 id、恢复行为、压缩和应用服务器执行。OpenClaw 仍然拥有聊天通道、可见记录镜像、工具策略、审批、媒体传递和会话选择。当你需要证明使用了 Codex 应用服务器路径并且 PI 回退没有隐藏损坏的原生执行器时，使用 `embeddedHarness.runtime: "codex"` 和 `embeddedHarness.fallback: "none"`。

## 禁用 PI 回退

默认情况下，OpenClaw 使用 `agents.defaults.embeddedHarness` 设置为 `{ runtime: "auto", fallback: "pi" }` 运行嵌入式代理。在 `auto` 模式下，已注册的插件执行器可以声明提供商/模型对。如果没有匹配，或者如果自动选择的插件执行器在产生输出之前失败，OpenClaw 会回退到 PI。

当你需要证明插件执行器是唯一正在使用的运行时时，设置 `fallback: "none"`。这会禁用自动 PI 回退；它不会阻止显式的 `runtime: "pi"` 或 `OPENCLAW_AGENT_RUNTIME=pi`。

对于仅 Codex 的嵌入式运行：

```json
{
  "agents": {
    "defaults": {
      "model": "codex/gpt-5.4",
      "embeddedHarness": {
        "runtime": "codex",
        "fallback": "none"
      }
    }
  }
}
```

如果你希望任何已注册的插件执行器声明匹配的模型，但永远不希望 OpenClaw 静默回退到 PI，请保持 `runtime: "auto"` 并禁用回退：

```json
{
  "agents": {
    "defaults": {
      "embeddedHarness": {
        "runtime": "auto",
        "fallback": "none"
      }
    }
  }
}
```

每个代理的覆盖使用相同的形状：

```json
{
  "agents": {
    "defaults": {
      "embeddedHarness": {
        "runtime": "auto",
        "fallback": "pi"
      }
    },
    "list": [
      {
        "id": "codex-only",
        "model": "codex/gpt-5.4",
        "embeddedHarness": {
          "runtime": "codex",
          "fallback": "none"
        }
      }
    ]
  }
}
```

`OPENCLAW_AGENT_RUNTIME` 仍然覆盖配置的运行时。使用 `OPENCLAW_AGENT_HARNESS_FALLBACK=none` 从环境中禁用 PI 回退。

```bash
OPENCLAW_AGENT_RUNTIME=codex \
OPENCLAW_AGENT_HARNESS_FALLBACK=none \
openclaw gateway run
```

禁用回退后，当请求的执行器未注册、不支持解析的提供商/模型，或在产生轮次副作用之前失败时，会话会早期失败。这对于仅 Codex 的部署和必须证明 Codex 应用服务器路径实际在使用的实时测试是有意的。

此设置仅控制嵌入式代理执行器。它不会禁用图像、视频、音乐、TTS、PDF 或其他提供商特定的模型路由。

## 原生会话和记录镜像

执行器可能会保留原生会话 id、线程 id 或守护进程端恢复令牌。将该绑定明确关联到 OpenClaw 会话，并继续将用户可见的助手/工具输出镜像到 OpenClaw 记录中。

OpenClaw 记录仍然是以下内容的兼容性层：

- 通道可见的会话历史
- 记录搜索和索引
- 在以后的轮次切换回内置的 PI 执行器
- 通用的 `/new`、`/reset` 和会话删除行为

如果你的执行器存储侧车绑定，请实现 `reset(...)`，以便 OpenClaw 可以在拥有的 OpenClaw 会话重置时清除它。

## 工具和媒体结果

核心构建 OpenClaw 工具列表并将其传递到准备好的尝试中。当执行器执行动态工具调用时，通过执行器结果形状返回工具结果，而不是自己发送通道媒体。

这使得文本、图像、视频、音乐、TTS、审批和消息工具输出与 PI 支持的运行在同一传递路径上。

## 当前限制

- 公共导入路径是通用的，但一些尝试/结果类型别名仍然带有 `Pi` 名称以保持兼容性。
- 第三方执行器安装是实验性的。在需要原生会话运行时之前，首选提供商插件。
- 执行器切换在轮次之间受支持。在原生工具、审批、助手文本或消息发送开始后，不要在轮次中间切换执行器。

## 相关

- [SDK 概述](/plugins/sdk-overview)
- [运行时助手](/plugins/sdk-runtime)
- [提供商插件](/plugins/sdk-provider-plugins)
- [Codex 执行器](/plugins/codex-harness)
- [模型提供商](/concepts/model-providers)