/**
 * Default消息处理管线工厂
 *
 * Register middleware by stage, building the complete message processing pipeline.
 */

import { MessagePipeline } from "./engine.js";
import {
  extractContent,
  skipSelf,
  skipPlaceholder,
  resolveQuote,
  recordMember,
  guardSpecialCommand,
  guardCommand,
  resolveMention,
  guardGroupCommand,
  guardSendAccess,
  rewriteBody,
  downloadMedia,
  resolveRoute,
  resolveTrace,
  buildContext,
  prepareSender,
  dispatchReply,
} from "./middlewares/index.js";

export function createPipeline(): MessagePipeline {
  return (
    new MessagePipeline()
      // 阶段 1：消息解析
      .use(extractContent) // 提取文本/媒体/@信息
      .use(skipSelf) // 跳过机器人自身消息
      .use(skipPlaceholder) // 跳过占位符/空消息
      .use(resolveQuote) // 引用消息解析
      .use(recordMember) // 记录群成员信息（群聊）
      // 阶段 2：守卫
      .use(guardSpecialCommand) // 升级命令/issue-log Owner 守卫
      .use(guardCommand) // SDK resolveControlCommandGate
      .use(resolveMention) // SDK resolveMentionGatingWithBypass（群聊）
      .use(guardGroupCommand) // 群命令白名单（群聊）
      .use(guardSendAccess) // 发送访问控制守卫（C2C）
      // 阶段 3：消息预处理
      .use(rewriteBody) // 命令改写 + 引用拼接 + mentions 拼接
      .use(downloadMedia) // 媒体下载
      // 阶段 4：路由 & 上下文构建
      .use(resolveRoute) // SDK resolveAgentRoute + resolveInboundSessionEnvelopeContext
      .use(resolveTrace) // 解析链路追踪上下文（trace_id / seq_id → ctx.traceContext）
      .use(buildContext) // SDK finalizeInboundContext + 群历史上下文
      // 阶段 5：发送器准备 & AI 调度
      .use(prepareSender) // ⭐ 创建 MessageSender + QueueSession（中间件化）
      .use(dispatchReply)
  ); // ⭐ SDK dispatchInboundReplyWithBase
}
