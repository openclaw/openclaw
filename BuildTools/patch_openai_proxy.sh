#!/bin/bash

# ==============================================================================
# OpenClaw OpenAI Proxy Endpoint & User-Agent Fixer
# 作用：修复 OpenClaw 忽略自定义 OpenAI baseUrl 的 Bug，并支持自定义 User-Agent
# ==============================================================================

PROJECT_ROOT="/Users/ppg/PPClaw/openclaw"
SRC_DIR="$PROJECT_ROOT/src"

echo "🚀 开始应用 OpenAI Proxy 修复补丁..."

# 1. 修复 src/agents/openai-ws-connection.ts
# 增加 headers 支持和自定义 URL 处理
WS_CONN_FILE="$SRC_DIR/agents/openai-ws-connection.ts"
if [ -f "$WS_CONN_FILE" ]; then
    echo "  -> 正在处理 openai-ws-connection.ts..."
    
    # 注入 headers 定义到接口
    sed -i '' 's/backoffDelaysMs?: readonly number\[\];/backoffDelaysMs?: readonly number[];\n  headers?: Record<string, string>;/' "$WS_CONN_FILE"
    
    # 修改构造函数
    sed -i '' 's/private readonly backoffDelaysMs: readonly number\[\];/private readonly backoffDelaysMs: readonly number[];\n  private readonly headers?: Record<string, string>;/' "$WS_CONN_FILE"
    sed -i '' 's/this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;/this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;\n    this.headers = options.headers;/' "$WS_CONN_FILE"
    
    # 应用 headers 到 WebSocket 连接
    sed -i '' '/Authorization: `Bearer ${this.apiKey}`,/i \
          ...this.headers,' "$WS_CONN_FILE"
fi

# 2. 修复 src/agents/pi-embedded-runner/run/attempt.ts
# 注入解析 baseUrl 和 headers 的逻辑
ATTEMPT_FILE="$SRC_DIR/agents/pi-embedded-runner/run/attempt.ts"
if [ -f "$ATTEMPT_FILE" ]; then
    echo "  -> 正在处理 pi-embedded-runner/run/attempt.ts..."
    
    # 查找注入点并替换逻辑
    # 逻辑：将原来的简单调用替换为带 URL 解析和 Headers 注入的完整逻辑
    python3 -c "
import sys
content = open('$ATTEMPT_FILE').read()
old_code = '''          activeSession.agent.streamFn = createOpenAIWebSocketStreamFn(wsApiKey, params.sessionId, {
            signal: runAbortController.signal,
          });'''
new_code = '''          const providerConfig = params.config?.models?.providers?.[params.provider];
          const providerBaseUrl =
            typeof providerConfig?.baseUrl === 'string' ? providerConfig.baseUrl : undefined;
          let wsUrl: string | undefined;
          if (providerBaseUrl) {
            try {
              const url = new URL(providerBaseUrl);
              url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
              if (!url.pathname.endsWith('/responses')) {
                url.pathname = url.pathname.endsWith('/') ? \`{url.pathname}responses\` : \`{url.pathname}/responses\`;
              }
              wsUrl = url.toString();
            } catch { /* ignore */ }
          }
          const headers = providerConfig?.headers
            ? Object.fromEntries(
                Object.entries(providerConfig.headers).map(([k, v]) => [k, String(v)]),
              )
            : undefined;
          activeSession.agent.streamFn = createOpenAIWebSocketStreamFn(wsApiKey, params.sessionId, {
            signal: runAbortController.signal,
            managerOptions: {
              url: wsUrl,
              headers,
            },
          });'''
# 这里的实现为了脚本健壮性使用更基础的模式匹配
if old_code in content:
    with open('$ATTEMPT_FILE', 'w') as f:
        f.write(content.replace(old_code, new_code))
else:
    print('警告: 未找到匹配的代码段，可能代码结构已变更。')
"
fi

# 3. 重新编译项目
echo "🏗️ 正在重新编译项目..."
cd "$PROJECT_ROOT" && pnpm build

# 4. 重启服务
echo "🔄 正在重启 OpenClaw 服务..."
cd "$PROJECT_ROOT/BuildTools" && ./restart_openclaw.sh

echo "✅ 补丁应用完成！"
