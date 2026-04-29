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

bundled_channel_stage_dir() {
  printf "%s" "${OPENCLAW_PLUGIN_STAGE_DIR:-$(bundled_channel_stage_root)}"
}

bundled_channel_install_package() {
  openclaw_e2e_install_package "$@"
}

bundled_channel_find_external_dep_package() {
  local dep_path="$1"
  find "$(bundled_channel_stage_root)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

bundled_channel_find_staged_dep_package() {
  local dep_path="$1"
  find "$(bundled_channel_stage_dir)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

bundled_channel_dump_stage_dir() {
  find "$(bundled_channel_stage_dir)" -maxdepth 12 -type f | sort | head -160 >&2 || true
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

bundled_channel_assert_no_staged_dep() {
  local channel="$1"
  local dep_path="$2"
  local message="${3:-$channel unexpectedly staged $dep_path}"
  if [ -n "$(bundled_channel_find_staged_dep_package "$dep_path")" ]; then
    echo "$message" >&2
    bundled_channel_dump_stage_dir
    exit 1
  fi
}

bundled_channel_assert_staged_dep() {
  local channel="$1"
  local dep_path="$2"
  local log_file="${3:-}"
  if [ -n "$(bundled_channel_find_staged_dep_package "$dep_path")" ]; then
    return 0
  fi
  echo "missing external staged dependency sentinel for $channel: $dep_path" >&2
  if [ -n "$log_file" ]; then
    cat "$log_file" >&2 || true
  fi
  bundled_channel_dump_stage_dir
  exit 1
}

bundled_channel_assert_no_staged_manifest_spec() {
  local channel="$1"
  local dep_path="$2"
  local log_file="${3:-}"
  if ! node - <<'NODE' "$(bundled_channel_stage_dir)" "$dep_path"
const fs = require("node:fs");
const path = require("node:path");

const stageDir = process.argv[2];
const depName = process.argv[3];
const manifestName = ".openclaw-runtime-deps.json";
const matches = [];

function visit(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (entry.name !== manifestName) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue;
    }
    const specs = Array.isArray(parsed.specs) ? parsed.specs : [];
    for (const spec of specs) {
      if (typeof spec === "string" && spec.startsWith(`${depName}@`)) {
        matches.push(`${fullPath}: ${spec}`);
      }
    }
  }
}

visit(stageDir);
if (matches.length > 0) {
  process.stderr.write(`${matches.join("\n")}\n`);
  process.exit(1);
}
NODE
  then
    echo "$channel unexpectedly selected $dep_path for external runtime deps" >&2
    if [ -n "$log_file" ]; then
      cat "$log_file" >&2 || true
    fi
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
  node - <<'NODE' "$mode" "${TOKEN:-bundled-channel-config-token}" "${PORT:-18789}"
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const token = process.argv[3];
const port = Number(process.argv[4]);
const configPath =
  process.env.OPENCLAW_BUNDLED_CHANNEL_CONFIG_PATH ||
  path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

if (mode === "disabled-config") {
  const stateDir = path.dirname(configPath);
  const disabledConfig = {
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: "disabled-config-runtime-deps-token",
      },
    },
    plugins: {
      enabled: true,
      entries: {
        discord: { enabled: false },
      },
    },
    channels: {
      telegram: {
        enabled: false,
        botToken: "123456:disabled-config-token",
        dmPolicy: "disabled",
        groupPolicy: "disabled",
      },
      slack: {
        enabled: false,
        botToken: "xoxb-disabled-config-token",
        appToken: "xapp-disabled-config-token",
      },
      discord: {
        enabled: true,
        token: "disabled-plugin-entry-token",
        dmPolicy: "disabled",
        groupPolicy: "disabled",
      },
    },
  };
  fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(disabledConfig, null, 2)}\n`, "utf8");
  fs.chmodSync(stateDir, 0o700);
  fs.chmodSync(configPath, 0o600);
  process.exit(0);
}

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
    botToken:
      process.env.OPENCLAW_BUNDLED_CHANNEL_TELEGRAM_TOKEN ||
      "123456:bundled-channel-update-token",
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
    botToken:
      process.env.OPENCLAW_BUNDLED_CHANNEL_SLACK_BOT_TOKEN ||
      "xoxb-bundled-channel-update-token",
    appToken:
      process.env.OPENCLAW_BUNDLED_CHANNEL_SLACK_APP_TOKEN ||
      "xapp-bundled-channel-update-token",
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
if (mode === "setup-entry-channels") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
  };
  config.channels = {
    ...(config.channels || {}),
    feishu: {
      ...(config.channels?.feishu || {}),
      enabled: true,
    },
    whatsapp: {
      ...(config.channels?.whatsapp || {}),
      enabled: true,
    },
  };
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}
