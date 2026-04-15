import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

/**
 * 私聊（DM）消息处理配置 schema
 *
 * Controls the policy and allowlist for the bot to accept direct messages, limiting which users can have one-on-one conversations with the bot.
 */
// const dmSchema = {
//   type: "object",
//   properties: {
//     /** 是否启用私聊功能 */
//     enabled: { type: "boolean" },
//     /**
//      * 私聊准入策略：
//      * - "pairing": 配对模式，需双向确认后才允许私聊
//      * - "allowlist": 仅允许白名单中的用户私聊（配合 allowFrom 使用）
//      * - "open": 开放模式，任何用户都可以私聊机器人
//      * - "disabled": 禁用私聊功能
//      */
//     policy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
//     /** 私聊白名单，仅在 policy 为 "allowlist" 时生效，可填写User ID（字符串或数字格式） */
//     allowFrom: {
//       type: "array",
//       items: { oneOf: [{ type: "string" }, { type: "number" }] },
//     },
//   },
//   additionalProperties: false,
// };

/**
 * 单个元宝账号的配置 schema
 *
 * 用于校验每个 IM 机器人账号的连接参数、身份信息和消息行为配置。
 * 支持多账号场景下每个子账号独立配置，子账号配置会覆盖顶层Default配置。
 */
// const accountSchema = {
//   type: "object",
//   properties: {
//     /** 账号显示名称，用于日志和管理界面标识 */
//     name: { type: "string" },
//     /** 是否启用该账号，设为 false 可临时禁用而不删除配置 */
//     enabled: { type: "boolean" },
//     appKey: { type: "string" },
//     appSecret: { type: "string" },
//     botId: { type: "string" },
//     apiDomain: { type: "string" },
//     /** WebSocket 鉴权 token，用于长连接身份验证 */
//     token: { type: "string" },
//     /**
//      * 消息超长时的溢出处理策略：
//      * - "stop": 截断并发送"内容较长，已停止发送剩余内容"提示
//      * - "split": 将长消息自动拆分为多条消息分段发送
//      */
//     overflowPolicy: { type: "string", enum: ["stop", "split"] },
//     /** Markdown 表格转换模式 */
//     chunkMode: { type: "string" },
//     /** Max file size in MB（Default 20，最小 1） */
//     mediaMaxMb: { type: "number", minimum: 1 },
//     /** 私聊（DM）消息处理配置 */
//     dm: dmSchema,
//   },
//   required: [],
//   additionalProperties: false,
// };

export const yuanbaoConfigSchema: ChannelConfigSchema = {
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      // name: { type: "string" },
      // enabled: { type: "boolean" },
      appKey: {
        type: "string",
        title: "APP ID",
        description: "元宝 APP 的 APP ID，用于鉴权和连接服务",
      },
      appSecret: {
        type: "string",
        title: "APP Secret",
        description: "元宝 APP 的 APP Secret，请妥善保管避免泄露",
      },
      token: {
        type: "string",
        title: "鉴权 Token",
        description: "元宝 APP 的鉴权 Token，请妥善保管避免泄露",
      },
      overflowPolicy: {
        type: "string",
        title: "超长消息处理策略",
        description: "消息过长时的处理方式：stop 为停止发送，split 为拆分后继续发送",
        enum: ["stop", "split"],
        default: "split",
      },
      /** Group chat reply-to strategy：off=不引用，first=同一消息仅首次引用，all=每条都引用 */
      replyToMode: {
        type: "string",
        title: "群聊引用回复策略",
        description: "off 不引用，first 同一消息仅首次引用，all 每条回复都引用",
        enum: ["off", "first", "all"],
        default: "first",
      },
      /**
       * Outbound queue strategy:
       * - merge-text（Default）：聚合文本后发送，支持 minChars/maxChars/idleMs 控制
       * - immediate：逐条发送，不做缓冲（如需旧行为可显式配置）
       */
      outboundQueueStrategy: {
        type: "string",
        title: "出站消息发送策略",
        description: "merge-text 聚合文本后发送（默认），immediate 逐条发送不做缓冲",
        enum: ["immediate", "merge-text"],
        default: "merge-text",
      },
      /** merge-text 策略：触发发送的最小字符数（Default 2800） */
      minChars: {
        type: "integer",
        title: "消息聚合最小字符数",
        description: "merge-text 策略下，缓冲区积累到此字符数后触发发送",
        minimum: 1,
        default: 2800,
      },
      /** merge-text 策略：单条消息的最大字符数（Default 3000） */
      maxChars: {
        type: "integer",
        title: "单条消息最大字符数",
        description: "merge-text 策略下，超过此字符数时强制切割（fence-aware）",
        minimum: 1,
        default: 3000,
      },
      /** merge-text 策略：无新内容后自动 flush 的空闲等待时长 ms（Default 5000） */
      idleMs: {
        type: "integer",
        title: "空闲自动发送超时 (ms)",
        description: "merge-text 策略下，超过该时长无新内容时自动发送缓冲区",
        minimum: 0,
        default: 5000,
      },
      mediaMaxMb: {
        type: "number",
        title: "媒体文件大小上限（MB）",
        description: "单个媒体文件允许发送的最大体积，单位 MB，最小值为 1",
        minimum: 1,
        default: 20,
      },
      /** Max group chat history context entries（0 表示禁用，Default使用 SDK 内置值） */
      historyLimit: {
        type: "number",
        title: "群聊上下文历史条数",
        description: "参与上下文构建的群聊历史消息条数上限，0 表示禁用",
        minimum: 0,
        default: 100,
      },
      /** Whether to disable block streaming output (default false) */
      disableBlockStreaming: {
        type: "boolean",
        title: "禁用分块流式输出",
        description: "开启后将关闭分块流式发送能力，改为非分块输出",
        default: false,
      },
      /** Whether group chat requires @mention to reply (default true) */
      requireMention: {
        type: "boolean",
        title: "群聊需要 @ 机器人",
        description: "开启后群聊消息必须 @ 机器人才会触发回复；关闭后机器人回复所有群消息",
        default: true,
      },
      /** Fallback reply text, automatically sent to the user when the AI model returns no reply content */
      fallbackReply: {
        type: "string",
        title: "兜底回复文案",
        description: "当 AI 未返回有效回复内容时，自动发送给用户的兜底文本",
        default: "暂时无法解答，你可以换个问题问问我哦",
      },
      /**
       * Whether to inject instructions in the system prompt to prevent markdown code blocks from wrapping the entire reply (default true)。
       * 开启后可防止模型将整段回复用 ```markdown 包裹。
       */
      markdownHintEnabled: {
        type: "boolean",
        title: "注入 Markdown 格式指令",
        description: "开启后在系统提示词中自动注入指令，防止模型用代码块包裹整个 Markdown 回复",
        default: true,
      },
      debugBotIds: {
        type: "array",
        items: { type: "string" },
        title: "调试白名单 Bot ID",
        description: "白名单内的 Bot ID 日志输出不做脱敏处理，方便开发调试。填写 bot 的 IM 用户 ID",
        default: [],
      },
      // dm: dmSchema,
      // defaultAccount: { type: "string" },
      // accounts: {
      //   type: "object",
      //   additionalProperties: accountSchema,
      // },
    },
    additionalProperties: false,
  },
};
