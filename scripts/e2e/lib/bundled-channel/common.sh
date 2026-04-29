#!/usr/bin/env bash
#
# Container-side helpers shared by bundled channel Docker E2E scenarios.
# These functions assume the OpenClaw package is installed globally inside the
# test container and the scenario has exported HOME/OPENAI_API_KEY as needed.

bundled_channel_package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

bundled_channel_stage_root() {
  printf "%s/.openclaw/plugin-runtime-deps" "$HOME"
}

bundled_channel_find_external_dep_package() {
  local dep_path="$1"
  find "$(bundled_channel_stage_root)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

bundled_channel_assert_no_package_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  for candidate in \
    "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" \
    "$root/dist/extensions/node_modules/$dep_path/package.json" \
    "$root/node_modules/$dep_path/package.json"; do
    if [ -f "$candidate" ]; then
      echo "packaged install should not mutate package tree for $channel: $candidate" >&2
      exit 1
    fi
  done
  if [ -f "$HOME/node_modules/$dep_path/package.json" ]; then
    echo "bundled runtime deps should not use HOME npm project for $channel: $HOME/node_modules/$dep_path/package.json" >&2
    exit 1
  fi
}

bundled_channel_assert_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  if [ -n "$(bundled_channel_find_external_dep_package "$dep_path")" ]; then
    bundled_channel_assert_no_package_dep_available "$channel" "$dep_path" "$root"
    return 0
  fi
  echo "missing dependency sentinel for $channel: $dep_path" >&2
  find "$root/dist/extensions/$channel" -maxdepth 3 -type f | sort | head -80 >&2 || true
  find "$root/node_modules" -maxdepth 3 -path "*/$dep_path/package.json" -type f -print >&2 || true
  find "$(bundled_channel_stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
  exit 1
}

bundled_channel_assert_no_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  bundled_channel_assert_no_package_dep_available "$channel" "$dep_path" "$root"
  if [ -n "$(bundled_channel_find_external_dep_package "$dep_path")" ]; then
    echo "dependency sentinel should be absent before repair for $channel: $dep_path" >&2
    exit 1
  fi
}

bundled_channel_remove_runtime_dep() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  rm -rf "$root/dist/extensions/$channel/node_modules"
  rm -rf "$root/dist/extensions/node_modules/$dep_path"
  rm -rf "$root/node_modules/$dep_path"
  rm -rf "$(bundled_channel_stage_root)"
}

bundled_channel_write_config() {
  local mode="$1"
  node - <<'NODE' "$mode" "${TOKEN:?missing TOKEN}" "${PORT:?missing PORT}"
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const token = process.argv[3];
const port = Number(process.argv[4]);
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

config.gateway = {
  ...(config.gateway || {}),
  port,
  auth: { mode: "token", token },
  controlUi: { enabled: false },
};
config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: { primary: "openai/gpt-4.1-mini" },
  },
};
config.models = {
  ...(config.models || {}),
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...(config.models?.providers?.openai || {}),
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      models: [],
    },
  },
};
config.plugins = {
  ...(config.plugins || {}),
  enabled: true,
};
config.channels = {
  ...(config.channels || {}),
  telegram: {
    ...(config.channels?.telegram || {}),
    enabled: mode === "telegram",
    botToken: "123456:bundled-channel-update-token",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  discord: {
    ...(config.channels?.discord || {}),
    enabled: mode === "discord",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  slack: {
    ...(config.channels?.slack || {}),
    enabled: mode === "slack",
    botToken: "xoxb-bundled-channel-update-token",
    appToken: "xapp-bundled-channel-update-token",
  },
  feishu: {
    ...(config.channels?.feishu || {}),
    enabled: mode === "feishu",
  },
};
if (mode === "memory-lancedb") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
    allow: [...new Set([...(config.plugins?.allow || []), "memory-lancedb"])],
    slots: {
      ...(config.plugins?.slots || {}),
      memory: "memory-lancedb",
    },
    entries: {
      ...(config.plugins?.entries || {}),
      "memory-lancedb": {
        ...(config.plugins?.entries?.["memory-lancedb"] || {}),
        enabled: true,
        config: {
          ...(config.plugins?.entries?.["memory-lancedb"]?.config || {}),
          embedding: {
            ...(config.plugins?.entries?.["memory-lancedb"]?.config?.embedding || {}),
            apiKey: process.env.OPENAI_API_KEY,
            model: "text-embedding-3-small",
          },
          dbPath: process.env.OPENCLAW_BUNDLED_CHANNEL_MEMORY_DB_PATH || "~/.openclaw/memory/lancedb-e2e",
          autoCapture: false,
          autoRecall: false,
        },
      },
    },
  };
}
if (mode === "acpx") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
    allow:
      Array.isArray(config.plugins?.allow) && config.plugins.allow.length > 0
        ? [...new Set([...config.plugins.allow, "acpx"])]
        : config.plugins?.allow,
    entries: {
      ...(config.plugins?.entries || {}),
      acpx: {
        ...(config.plugins?.entries?.acpx || {}),
        enabled: true,
      },
    },
  };
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}
