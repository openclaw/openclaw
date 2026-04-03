/**
 * wecom_mcp — 模拟 MCP 调用的 Agent Tool
 *
 * 通过 MCP Streamable HTTP 传输协议调用企业微信 MCP Server，
 * 提供 list（列出所有工具）和 call（调用工具）两个操作。
 *
 * 在 skills 中的使用方式：
 *   wecom_mcp list <category>
 *   wecom_mcp call <category> <method> '<jsonArgs>'
 *
 * 示例：
 *   wecom_mcp list contact
 *   wecom_mcp call contact getContact '{}'
 */

import { sendJsonRpc, type McpToolInfo } from "./transport.js";
import { cleanSchemaForGemini } from "./schema.js";
import { resolveBeforeCall, runAfterCall } from "./interceptors/index.js";

// ============================================================================
// 类型定义
// ============================================================================

/** wecom_mcp 的入参 */
interface WeComToolsParams {
  /** 操作类型：list | call */
  action: "list" | "call";
  /** MCP 品类，对应 mcpConfig 中的 key，如 doc、contact */
  category: string;
  /** 调用的 MCP 方法名（action=call 时必填） */
  method?: string;
  /** 调用 MCP 方法的 JSON 参数（action=call 时使用） */
  args?: string | Record<string, unknown>;
}

// ============================================================================
// 响应构造辅助
// ============================================================================

/** 构造统一的文本响应结构 */
const textResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** 构造错误响应 */
const errorResult = (err: unknown) => {
  // 适配企业微信 API 返回的 { errcode, errmsg } 结构
  if (err && typeof err === "object" && "errcode" in err) {
    const { errcode, errmsg } = err as { errcode: number; errmsg?: string };
    return textResult({ error: errmsg ?? `错误码: ${errcode}`, errcode });
  }

  const message = err instanceof Error ? err.message : String(err);
  return textResult({ error: message });
};

// ============================================================================
// list 操作：列出某品类的所有 MCP 工具
// ============================================================================

const handleList = async (category: string): Promise<unknown> => {
  const result = await sendJsonRpc(category, "tools/list") as { tools?: McpToolInfo[] } | undefined;

  const tools = result?.tools ?? [];
  if (tools.length === 0) {
    return { message: `品类 "${category}" 下暂无可用工具`, tools: [] };
  }

  return {
    category,
    count: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      // 清洗 inputSchema，内联 $ref/$defs 引用并移除 Gemini 不支持的关键词，
      // 避免 Gemini 模型解析 function response 时报 400 错误
      inputSchema: t.inputSchema ? cleanSchemaForGemini(t.inputSchema) : undefined,
    })),
  };
};

// ============================================================================
// call 操作：调用某品类的某个 MCP 工具
// ============================================================================

const handleCall = async (
  category: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const ctx = { category, method, args };
  const callStart = performance.now();

  console.log(`[mcp] handleCall ${category}/${method} 入参: ${JSON.stringify(args)}`);

  // 1. 收集拦截器的 beforeCall 配置（如超时时间、替换 args）
  const { options, args: resolvedArgs } = await resolveBeforeCall(ctx);
  const finalArgs = resolvedArgs ?? args;

  if (resolvedArgs) {
    console.log(
      `[mcp] handleCall ${category}/${method} 拦截器替换 args: ${JSON.stringify(resolvedArgs).slice(0, 500)}` +
      (JSON.stringify(resolvedArgs).length > 500 ? "...(truncated)" : ""),
    );
  }
  if (options) {
    console.log(`[mcp] handleCall ${category}/${method} 拦截器选项: ${JSON.stringify(options)}`);
  }

  // 2. 执行 MCP 调用
  const result = await sendJsonRpc(category, "tools/call", {
    name: method,
    arguments: finalArgs,
  }, options);

  const rpcDone = performance.now();
  const rpcMs = (rpcDone - callStart).toFixed(1);

  const resultStr = JSON.stringify(result);
  console.log(
    `[mcp] handleCall ${category}/${method} MCP 响应 (${rpcMs}ms): ${resultStr.slice(0, 800)}` +
    (resultStr.length > 800 ? "...(truncated)" : ""),
  );

  // 3. 管道式执行 afterCall 拦截器（业务错误码检查、响应变换等）
  const finalResult = await runAfterCall(ctx, result);

  const totalMs = (performance.now() - callStart).toFixed(1);
  const interceptMs = (performance.now() - rpcDone).toFixed(1);

  // 有拦截器处理时打印详细耗时，否则只打印 RPC 耗时
  if (finalResult !== result) {
    const finalStr = JSON.stringify(finalResult);
    console.log(
      `[mcp] handleCall ${category}/${method} afterCall 变换后 (${interceptMs}ms): ${finalStr.slice(0, 500)}` +
      (finalStr.length > 500 ? "...(truncated)" : ""),
    );
    console.log(
      `[mcp] handleCall ${category}/${method} 总耗时: ${totalMs}ms` +
      ` (MCP请求: ${rpcMs}ms, 拦截处理: ${interceptMs}ms)`,
    );
  } else {
    console.log(`[mcp] handleCall ${category}/${method} 耗时: ${rpcMs}ms`);
  }

  return finalResult;
};

// ============================================================================
// 参数解析
// ============================================================================

/**
 * 解析 args 参数：支持 JSON 字符串或直接的对象
 */
const parseArgs = (args: string | Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof SyntaxError ? err.message : String(err);
    throw new Error(`args 参数不是合法的 JSON: ${args} (${detail})`);
  }
};

// ============================================================================
// 工具定义 & 导出
// ============================================================================

/**
 * 创建 wecom_mcp Agent Tool 定义
 */
export function createWeComMcpTool() {
  return {
    name: "wecom_mcp",
    label: "企业微信 MCP 工具",
    description: [
      "通过 HTTP 直接调用企业微信 MCP Server。",
      "支持两种操作：",
      "  - list: 列出指定品类的所有 MCP 工具",
      "  - call: 调用指定品类的某个 MCP 工具",
      "",
      "使用方式：",
      "  wecom_mcp list <category>",
      "  wecom_mcp call <category> <method> '<jsonArgs>'",
      "",
      "示例：",
      "  列出 contact 品类所有工具：wecom_mcp list contact",
      "  调用 contact 的 getContact：wecom_mcp call contact getContact '{}'",
    ].join("\n"),
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "call"],
          description: "操作类型：list（列出工具）或 call（调用工具）",
        },
        category: {
          type: "string",
          description: "MCP 品类名称，如 doc、contact 等，对应 mcpConfig 中的 key",
        },
        method: {
          type: "string",
          description: "要调用的 MCP 方法名（action=call 时必填）",
        },
        args: {
          type: ["string", "object"],
          description: "调用 MCP 方法的参数，可以是 JSON 字符串或对象（action=call 时使用，默认 {}）",
        },
      },
      required: ["action", "category"],
    },
    async execute(_toolCallId: string, params: unknown) {
      const p = params as WeComToolsParams;
      console.log(
        `[mcp] execute: action=${p.action}, category=${p.category}` +
        (p.method ? `, method=${p.method}` : "") +
        (p.args ? `, args=${typeof p.args === "string" ? p.args : JSON.stringify(p.args)}` : ""),
      );
      try {
        let result: ReturnType<typeof textResult>;
        switch (p.action) {
          case "list":
            result = textResult(await handleList(p.category));
            break;
          case "call": {
            if (!p.method) {
              result = textResult({ error: "action 为 call 时必须提供 method 参数" });
              break;
            }
            const args = parseArgs(p.args);
            result = textResult(await handleCall(p.category, p.method, args));
            break;
          }
          default:
            result = textResult({ error: `未知操作类型: ${String(p.action)}，支持 list 和 call` });
        }
        console.log(
          `[mcp] execute: action=${p.action}, category=${p.category}` +
          (p.method ? `, method=${p.method}` : "") +
          ` → 响应长度=${result.content[0].text.length} chars`,
        );
        return result;
      } catch (err) {
        console.error(
          `[mcp] execute: action=${p.action}, category=${p.category}` +
          (p.method ? `, method=${p.method}` : "") +
          ` → 异常: ${err instanceof Error ? err.message : String(err)}`,
        );
        return errorResult(err);
      }
    },
  };
}
