#!/bin/sh
set -e

# ── 运行时生成 gateway 配置 ──────────────────────────────
# 每次容器启动都重新写入，避免 volume 持久化旧配置覆盖新镜像
mkdir -p /root/.openfinclaw

# GATEWAY_ALLOWED_ORIGINS: 逗号分隔 → JSON 数组
ORIGINS_JSON=$(echo "${GATEWAY_ALLOWED_ORIGINS:-http://localhost:18789}" | sed 's/,/","/g' | sed 's/^/["/' | sed 's/$/"]/')

# GATEWAY_DEFAULT_MODEL: 可选，设置后覆盖内置默认模型
if [ -n "${GATEWAY_DEFAULT_MODEL}" ]; then
  AGENTS_JSON=",\"agents\":{\"defaults\":{\"model\":{\"primary\":\"${GATEWAY_DEFAULT_MODEL}\"}}}"
else
  AGENTS_JSON=""
fi

printf '{"gateway":{"mode":"local","bind":"lan","trustedProxies":["172.16.0.0/12","10.0.0.0/8"],"auth":{"mode":"token","token":"%s"},"controlUi":{"allowedOrigins":%s,"dangerouslyAllowHostHeaderOriginFallback":true,"allowInsecureAuth":true}},"plugins":{"slots":{"memory":"none"}}%s}\n' \
  "${GATEWAY_AUTH_TOKEN:-finclaw-dev}" "${ORIGINS_JSON}" "${AGENTS_JSON}" > /root/.openfinclaw/openfinclaw.json

echo "[entrypoint] Config written to /root/.openfinclaw/openfinclaw.json"
echo "[entrypoint] Plugins enabled (default), DataHub URL: ${DATAHUB_API_URL:-http://43.134.61.136:8088}"

# ── 启动 Gateway ─────────────────────────────────────────
exec node dist/index.js gateway --bind lan --port "${GATEWAY_PORT:-18789}"
