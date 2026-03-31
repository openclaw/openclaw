#!/usr/bin/env bash
# Post-install patch: fix openai-codex WebSocket→HTTP fallback losing apiKey
# Root cause: createOpenAIWebSocketStreamFn captures apiKey for WS connections
# but fallbackToHttp() doesn't inject it into options for streamSimple().
#
# This patch ensures all fallbackToHttp() calls include the captured apiKey.
# Applies to both dist/ bundle and node_modules provider.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# --- Patch 1: dist/pi-embedded (WebSocket fallback) ---
EMBEDDED="$REPO/dist/pi-embedded-D5egt2Rv.js"
if [ -f "$EMBEDDED" ]; then
  # Replace all unpatched fallbackToHttp calls inside createOpenAIWebSocketStreamFn
  # These are the ones that pass 'options' without apiKey injection
  sed -i 's|return fallbackToHttp(model, context, options, eventStream, opts\.signal);|return fallbackToHttp(model, context, { ...options, apiKey: apiKey ?? options?.apiKey }, eventStream, opts.signal);|g' "$EMBEDDED"
  echo "[patch] dist/pi-embedded: WebSocket fallback apiKey injection applied"
else
  echo "[patch] dist/pi-embedded not found, skipping"
fi

# --- Patch 2: node_modules openai-codex-responses (global fallback) ---
CODEX="$REPO/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js"
if [ -f "$CODEX" ]; then
  # Add globalThis fallback for apiKey in streamSimpleOpenAICodexResponses
  if ! grep -q '__openclawResolvedApiKeys' "$CODEX"; then
    sed -i 's|const apiKey = options?.apiKey || getEnvApiKey(model.provider);|const apiKey = options?.apiKey || getEnvApiKey(model.provider) || globalThis.__openclawResolvedApiKeys?.[model.provider];|g' "$CODEX"
    echo "[patch] openai-codex-responses: globalThis apiKey fallback applied"
  else
    echo "[patch] openai-codex-responses: already patched"
  fi
  # Same for streamOpenAICodexResponses main function
  if ! grep -q '__openclawResolvedApiKeys' "$CODEX"; then
    sed -i 's|const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";|const apiKey = options?.apiKey || getEnvApiKey(model.provider) || globalThis.__openclawResolvedApiKeys?.[model.provider] || "";|g' "$CODEX"
    echo "[patch] openai-codex-responses main: globalThis apiKey fallback applied"
  else
    echo "[patch] openai-codex-responses main: already patched"
  fi
fi

# --- Patch 3: node_modules auth-storage (store resolved keys globally) ---
AUTH="$REPO/node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js"
if [ -f "$AUTH" ]; then
  if ! grep -q '__openclawResolvedApiKeys' "$AUTH"; then
    sed -i '/const runtimeKey = this.runtimeOverrides.get(providerId);/a\        if (runtimeKey) { if (!globalThis.__openclawResolvedApiKeys) globalThis.__openclawResolvedApiKeys = {}; globalThis.__openclawResolvedApiKeys[providerId] = runtimeKey; }' "$AUTH"
    echo "[patch] auth-storage: globalThis key bridge applied"
  else
    echo "[patch] auth-storage: already patched"
  fi
fi

echo "[patch] all patches applied"
