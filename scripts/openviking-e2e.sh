#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENVIKING_DIR="${OPENVIKING_DIR:-$(cd "$REPO_DIR/.." && pwd)/OpenViking}"
OPENVIKING_CONF_SOURCE="${OPENVIKING_CONF_SOURCE:-$OPENVIKING_DIR/ov.conf}"
OPENVIKING_CONF_TMP="${OPENVIKING_CONF_TMP:-/tmp/ov-live-e2e.conf}"
OPENVIKING_LOG="${OPENVIKING_LOG:-/tmp/openviking-e2e.log}"
OPENVIKING_DATA_PATH="${OPENVIKING_DATA_PATH:-/tmp/openviking-data}"
OPENVIKING_HOST="${OPENVIKING_HOST:-127.0.0.1}"
OPENVIKING_PORT="${OPENVIKING_PORT:-1933}"
OPENVIKING_API_KEY="${OPENVIKING_API_KEY:-${OPENVIKING_APIKEY:-${APIKEY:-}}}"
OPENVIKING_AGFS_PORT="${OPENVIKING_AGFS_PORT:-4833}"
OPENVIKING_SPARSE_WEIGHT="${OPENVIKING_SPARSE_WEIGHT:-0.35}"
OPENVIKING_ENABLE_HYBRID="${OPENVIKING_ENABLE_HYBRID:-1}"
OPENVIKING_HEALTH_URL="http://${OPENVIKING_HOST}:${OPENVIKING_PORT}/health"
OPENVIKING_VENV="${OPENVIKING_VENV:-/tmp/openviking-venv/bin/activate}"
ZAI_API_KEY="${ZAI_API_KEY:-${APIKEY:-}}"
SESSION_ID="${SESSION_ID:-e2e-openviking}"

E2E_MESSAGE="${E2E_MESSAGE:-请严格按顺序调用 memory_store、memory_recall、memory_forget。先用 memory_store 保存：用户偏好中文简洁并先给结论后给步骤；再用 memory_recall 查询；最后仅当拿到 is_leaf=true 的 URI 时调用 memory_forget 删除。输出每步工具结果。}"

cd "$REPO_DIR"

if [ -z "$OPENVIKING_API_KEY" ]; then
  echo "Missing API key: set OPENVIKING_API_KEY (or OPENVIKING_APIKEY/APIKEY)." >&2
  exit 1
fi

if [ -z "$ZAI_API_KEY" ]; then
  echo "Missing API key: set ZAI_API_KEY (or APIKEY)." >&2
  exit 1
fi

pkill -f openviking-server || true
pkill -f agfs || true

if [ "$OPENVIKING_ENABLE_HYBRID" = "1" ]; then
  jq \
    '. + {
      storage: ((.storage // {}) + {
        agfs: ((.storage.agfs // {}) + {port: '"${OPENVIKING_AGFS_PORT}"'}),
        vectordb: ((.storage.vectordb // {}) + {sparse_weight: '"${OPENVIKING_SPARSE_WEIGHT}"'})
      }),
      server: ((.server // {}) + {api_key: "'"${OPENVIKING_API_KEY}"'"}),
      embedding: ((.embedding // {}) + {
        hybrid: ((.embedding.hybrid // .embedding.dense) + {
          provider: ((.embedding.hybrid.provider // .embedding.dense.provider) // "volcengine"),
          backend: ((.embedding.hybrid.backend // .embedding.dense.backend) // "volcengine"),
          input: ((.embedding.hybrid.input // .embedding.dense.input) // "multimodal")
        })
      })
    }' \
    "$OPENVIKING_CONF_SOURCE" >"$OPENVIKING_CONF_TMP"
else
  jq \
    '. + {
      storage: ((.storage // {}) + {agfs: ((.storage.agfs // {}) + {port: '"${OPENVIKING_AGFS_PORT}"'})}),
      server: ((.server // {}) + {api_key: "'"${OPENVIKING_API_KEY}"'"})
    }' \
    "$OPENVIKING_CONF_SOURCE" >"$OPENVIKING_CONF_TMP"
fi

source "$OPENVIKING_VENV"

export OPENVIKING_CONFIG_FILE="$OPENVIKING_CONF_TMP"
export OPENVIKING_API_KEY

openviking-server \
  --host "$OPENVIKING_HOST" \
  --port "$OPENVIKING_PORT" \
  --path "$OPENVIKING_DATA_PATH" \
  --api-key "$OPENVIKING_API_KEY" >"$OPENVIKING_LOG" 2>&1 &
OV_PID=$!

cleanup() {
  kill "$OV_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS "$OPENVIKING_HEALTH_URL" >/dev/null; then
    echo "OpenViking ready at $OPENVIKING_HEALTH_URL"
    break
  fi
  sleep 1
  i=$((i + 1))
done

if [ "$i" -eq 40 ]; then
  echo "OpenViking failed to become healthy"
  tail -n 120 "$OPENVIKING_LOG" || true
  exit 1
fi

ZAI_API_KEY="$ZAI_API_KEY" OPENVIKING_API_KEY="$OPENVIKING_API_KEY" pnpm openclaw --dev agent --local --json \
  --session-id "$SESSION_ID" \
  --message "$E2E_MESSAGE"
