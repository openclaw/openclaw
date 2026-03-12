/**
 * 类型层：直接引用 openclaw 官方类型定义（import type，零运行时依赖）
 *
 * 策略：
 *   - 所有与 openclaw 接口对应的类型均通过 import type 从官方源码引用，
 *     保证类型准确性，并随 openclaw 升级自动检测接口变化。
 *   - demo 工程专有类型（InboundMessage、PluginOrigin 等）保留在本文件。
 *   - DemoChannelGatewayContext 是 demo 工程扩展版，加入 onMessage 字段，
 *     供 demo-channel 等自定义插件使用。
 *
 * 迁移到 VSCode 时：
 *   将以下 import 路径中的 "../../../src/..." 替换为 submodule 路径即可，
 *   接口逻辑不变。
 */

// ─── 来自 openclaw 官方：Channel 核心类型 ─────────────────────────────────

// src/channels/plugins/types.core.ts
export type {
  ChannelId,
  ChannelMeta,
  ChannelCapabilities,
  ChannelAccountSnapshot,
} from "../../../src/channels/plugins/types.core.js";

// src/channels/plugins/types.adapters.ts
import type {
  ChannelConfigAdapter,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
} from "../../../src/channels/plugins/types.adapters.js";
export type {
  ChannelConfigAdapter,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
};

// src/channels/plugins/types.plugin.ts
export type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";

// ─── 来自 openclaw 官方：插件 API 类型 ────────────────────────────────────
// src/plugins/types.ts
export type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginOrigin,
  PluginLogger,
} from "../../../src/plugins/types.js";

// src/plugins/manifest.ts
export type { PluginManifest } from "../../../src/plugins/manifest.js";

// src/plugins/runtime/types.ts
export type { PluginRuntime } from "../../../src/plugins/runtime/types.js";

// src/plugins/runtime/types-core.ts
export type { PluginRuntimeCore } from "../../../src/plugins/runtime/types-core.js";

// ─── 来自 openclaw 官方：Agent 相关类型 ────────────────────────────────
// src/commands/agent/types.ts
export type {
  AgentCommandOpts,
  AgentCommandIngressOpts,
  ImageContent,
} from "../../../src/commands/agent/types.js";

// src/auto-reply/templating.ts
export type { MsgContext } from "../../../src/auto-reply/templating.js";

import type { MsgContext } from "../../../src/auto-reply/templating.js";
// 内部引用（用于 Pick 等类型操作）
import type { AgentCommandOpts } from "../../../src/commands/agent/types.js";

// ─── demo 工程专有类型 ────────────────────────────────────────────────────

/**
 * 诊断信息（discovery/loader 内部使用）
 *
 * openclaw 中无对应单一类型；此处定义与原版诊断对象形状保持一致。
 */
export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};

/**
 * 入站消息：Host 层标准化的消息格式（仅供 demo-channel 等简单场景使用）
 *
 * openclaw 中没有对应的单一类型（各 channel 的 inbound 格式各异，
 * 通过 dispatchReplyWithBufferedBlockDispatcher 分发给 agent）。
 * 本工程将其简化为统一的回调接口，承担 dispatchInboundReply 的角色。
 *
 * 注意：真实渠道插件（qqbot/dingtalk/feishu）应使用 ChannelMsgContext + AgentInput 链路。
 */
export type InboundMessage = {
  /** 发送者标识（如 user:123、nick@server） */
  from: string;
  /** 消息文本 */
  text: string;
  /** channel id（如 "demo-channel"、"irc"） */
  channel: string;
  /** 账户 ID */
  accountId: string;
  /** 便利函数：直接回复这条消息 */
  reply: (text: string) => Promise<void>;
};

/**
 * ChannelMsgContext: 路径 B/C（渠道插件）使用的消息上下文
 *
 * 直接等同于 openclaw 的 MsgContext（94 个字段，全部可选）。
 *
 * 设计原则：
 *   不做 Pick 子集 —— 保留全部字段，便于对照 openclaw 原版。
 *   转化函数只填核心字段，其余由外部插件按需传入。
 *   你可以选择性的不用这些字段，但类型上不能没有。
 *
 * 对应 openclaw: src/auto-reply/templating.ts MsgContext
 */
export type ChannelMsgContext = MsgContext;

/**
 * AgentInput: 统一的 LLM 调用输入接口
 *
 * 两条路径（HTTP API 和渠道插件）最终都产出这个统一格式，传给 agent。
 *
 * 设计原则：
 *   完整对齐 AgentCommandOpts —— 除 message 必选外，其余字段均为可选。
 *   转化函数只填核心字段，其余由外部按需传入。
 *   这样做的好处：
 *     1. 能看到外部（插件）传入的所有值，便于调试和对照 openclaw
 *     2. 类型自动跟随 openclaw 更新，无需手动同步
 *     3. 未来接入真实 LLM 时，可直接传给 agentCommandInternal
 */
export type AgentInput = Partial<AgentCommandOpts> & {
  /** 用户消息文本（唯一必选字段） */
  message: string;
};

/**
 * DemoChannelGatewayContext：官方 ChannelGatewayContext 的 demo 扩展版
 *
 * 在官方类型基础上追加 onMessage 字段，供 demo-channel 等 demo 专属插件使用。
 * 真实 openclaw 插件（qqbot/dingtalk/feishu）通过 ctx.channelRuntime.reply
 * 或 api.runtime.channel.reply 分发消息，不依赖 onMessage。
 */
export type DemoChannelGatewayContext<ResolvedAccount = unknown> =
  ChannelGatewayContext<ResolvedAccount> & {
    /**
     * 消息分发回调（仅 demo 工程使用）
     *
     * 真实插件通过 ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher
     * 分发消息；demo-channel 等 demo 专用插件通过此字段简化调用。
     */
    onMessage?: (msg: InboundMessage) => Promise<void>;
  };
