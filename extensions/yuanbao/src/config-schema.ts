export const yuanbaoConfigSchema = {
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
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
      /** Group chat reply-to strategy: off=no quote, first=quote only first reply per message, all=quote every reply */
      replyToMode: {
        type: "string",
        title: "群聊引用回复策略",
        description: "off 不引用，first 同一消息仅首次引用，all 每条回复都引用",
        enum: ["off", "first", "all"],
        default: "first",
      },
      /**
       * Outbound queue strategy:
       * - merge-text (default): aggregate text before sending, controlled by minChars/maxChars/idleMs
       * - immediate: send each chunk immediately without buffering
       */
      outboundQueueStrategy: {
        type: "string",
        title: "出站消息发送策略",
        description: "merge-text 聚合文本后发送（默认），immediate 逐条发送不做缓冲",
        enum: ["immediate", "merge-text"],
        default: "merge-text",
      },
      /** merge-text strategy: minimum chars to trigger send (default 2800) */
      minChars: {
        type: "integer",
        title: "消息聚合最小字符数",
        description: "merge-text 策略下，缓冲区积累到此字符数后触发发送",
        minimum: 1,
        default: 2800,
      },
      /** merge-text strategy: max chars per message (default 3000) */
      maxChars: {
        type: "integer",
        title: "单条消息最大字符数",
        description: "merge-text 策略下，超过此字符数时强制切割（fence-aware）",
        minimum: 1,
        default: 3000,
      },
      /** merge-text strategy: idle timeout (ms) before auto-flush (default 5000) */
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
      /** Max group chat history context entries (0=disabled, default uses SDK built-in value) */
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
       * Whether to inject instructions in the system prompt to prevent markdown code blocks from wrapping the entire reply (default true).
       * When enabled, prevents the model from wrapping the entire reply in ```markdown fences.
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
    },
    additionalProperties: false,
  },
};
