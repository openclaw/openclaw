/**
 * MCP call 拦截器类型定义
 *
 * 拦截器用于在 tools/call 调用前后注入特殊逻辑，
 * 如修改超时配置、变换响应结果等，避免在 tool.ts 中堆积 if/else。
 */

import type { SendJsonRpcOptions } from "../transport.js";

// ============================================================================
// 类型定义
// ============================================================================

/** MCP call 调用的上下文 */
export interface CallContext {
  /** MCP 品类，对应 mcpConfig 中的 key，如 doc、contact */
  category: string;
  /** 调用的 MCP 方法名 */
  method: string;
  /** 调用 MCP 方法的参数 */
  args: Record<string, unknown>;
}

/**
 * beforeCall 返回的选项
 *
 * 扩展 SendJsonRpcOptions，允许拦截器在调用前替换 args（如从本地文件读取请求体）。
 */
export interface BeforeCallOptions extends SendJsonRpcOptions {
  /** 替换后的 args（可选，不返回则使用原 args） */
  args?: Record<string, unknown>;
}

/**
 * call 拦截器接口
 *
 * 每个拦截器通过 match 判断是否对当前调用生效，
 * 生效时可在调用前（beforeCall）和调用后（afterCall）注入逻辑。
 */
export interface CallInterceptor {
  /** 拦截器名称（用于日志） */
  name: string;

  /**
   * 判断是否对当前调用生效
   *
   * 返回 true 时才会执行 beforeCall / afterCall
   */
  match(ctx: CallContext): boolean;

  /**
   * 在 sendJsonRpc 调用前修改请求选项和参数（可选）
   *
   * 如 get_msg_media 需要延长超时时间，
   * 如 smartpage_create 需要从本地文件读取请求体替换 args。
   * 返回的选项会与其他拦截器的结果合并（timeoutMs 取最大值，args 后者覆盖前者）。
   */
  beforeCall?(ctx: CallContext): BeforeCallOptions | Promise<BeforeCallOptions> | undefined;

  /**
   * 在 sendJsonRpc 返回后处理/变换结果（可选）
   *
   * 多个拦截器的 afterCall 按注册顺序管道式执行，
   * 前一个的返回值作为下一个的输入。
   */
  afterCall?(ctx: CallContext, result: unknown): Promise<unknown> | unknown;
}
