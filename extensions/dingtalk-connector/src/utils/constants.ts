/**
 * 常量定义模块
 */

/** 新会话触发命令 */
export const NEW_SESSION_COMMANDS = ['/new', '/reset', '/clear', '新会话', '重新开始', '清空对话'];

/**
 * 媒体类消息类型集合。
 *
 * 这些消息类型需要通过钉钉原生消息 API 发送，不支持 AI Card 形式，
 * 在 sendProactiveInternal 中会强制跳过 AI Card 路径。
 */
export const MEDIA_MSG_TYPES = new Set(['image', 'voice', 'file', 'video'] as const);

/**
 * 队列繁忙时的即时 ACK 回复短语。
 *
 * 当消息入队时检测到上一条消息仍在处理中，立即从此列表中随机选取一条回复，
 * 告知用户消息已收到并排队，避免用户以为 Bot 没有响应。
 * 参考 delivery.rs 中 DINGTALK_ACK_PHRASES_BUSY_ZH_CN 的设计。
 */
export const QUEUE_BUSY_ACK_PHRASES = [
  '上一条还没结束，这条我已经记下，稍后按顺序继续处理。',
  '当前还在忙，你的新消息已经排队，上一条完成后我马上继续。',
  '我这边还在处理上一条，这条已加入队列，完成后继续处理。',
] as const;
