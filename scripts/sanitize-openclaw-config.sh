#!/usr/bin/env sh
set -euo pipefail

CONFIG_PATH="${1:-$HOME/.openclaw/openclaw.json}"
BACKUP_PATH="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config not found: $CONFIG_PATH" >&2
  exit 1
fi

cp "$CONFIG_PATH" "$BACKUP_PATH"

python - "$CONFIG_PATH" <<'PY'
import json
import re
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
data = json.loads(config_path.read_text())

def set_path(obj, path, value):
    cur = obj
    for key in path[:-1]:
        if not isinstance(cur, dict):
            return
        if key not in cur or not isinstance(cur[key], dict):
            cur[key] = {}
        cur = cur[key]
    cur[path[-1]] = value

def env_ref(name: str) -> str:
    return f"${{{name}}}"

def skill_env_key(skill_id: str) -> str:
    key = re.sub(r"[^A-Za-z0-9]+", "_", skill_id).upper()
    return f"{key}_API_KEY"

def is_nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""

# Top-level env block: replace values with ${ENV_VAR}
env_block = data.get("env")
if isinstance(env_block, dict):
    for k, v in list(env_block.items()):
        if is_nonempty_string(v):
            env_block[k] = env_ref(k)

# Gateway auth
gateway = data.get("gateway")
if isinstance(gateway, dict):
    auth = gateway.get("auth")
    if isinstance(auth, dict):
        if is_nonempty_string(auth.get("token")):
            auth["token"] = env_ref("OPENCLAW_GATEWAY_TOKEN")
        if is_nonempty_string(auth.get("password")):
            auth["password"] = env_ref("OPENCLAW_GATEWAY_PASSWORD")

# Tools web search key
tools = data.get("tools")
if isinstance(tools, dict):
    web = tools.get("web")
    if isinstance(web, dict):
        search = web.get("search")
        if isinstance(search, dict) and is_nonempty_string(search.get("apiKey")):
            search["apiKey"] = env_ref("WEB_SEARCH_API_KEY")

# Talk API key
talk = data.get("talk")
if isinstance(talk, dict) and is_nonempty_string(talk.get("apiKey")):
    talk["apiKey"] = env_ref("ELEVENLABS_API_KEY")

# Channels (Slack tokens)
channels = data.get("channels")
if isinstance(channels, dict):
    slack = channels.get("slack")
    if isinstance(slack, dict):
        if is_nonempty_string(slack.get("botToken")):
            slack["botToken"] = env_ref("SLACK_BOT_TOKEN")
        if is_nonempty_string(slack.get("appToken")):
            slack["appToken"] = env_ref("SLACK_APP_TOKEN")

# Plugins (voice-call Twilio)
plugins = data.get("plugins")
if isinstance(plugins, dict):
    entries = plugins.get("entries")
    if isinstance(entries, dict):
        voice_call = entries.get("voice-call")
        if isinstance(voice_call, dict):
            vc_cfg = voice_call.get("config")
            if isinstance(vc_cfg, dict):
                twilio = vc_cfg.get("twilio")
                if isinstance(twilio, dict):
                    if is_nonempty_string(twilio.get("accountSid")):
                        twilio["accountSid"] = env_ref("TWILIO_ACCOUNT_SID")
                    if is_nonempty_string(twilio.get("authToken")):
                        twilio["authToken"] = env_ref("TWILIO_AUTH_TOKEN")

# Skills: replace any apiKey with ${<SKILL_ID>_API_KEY}
skills = data.get("skills")
if isinstance(skills, dict):
    entries = skills.get("entries")
    if isinstance(entries, dict):
        for skill_id, cfg in entries.items():
            if not isinstance(cfg, dict):
                continue
            if is_nonempty_string(cfg.get("apiKey")):
                cfg["apiKey"] = env_ref(skill_env_key(skill_id))
            env_cfg = cfg.get("env")
            if isinstance(env_cfg, dict):
                for k, v in list(env_cfg.items()):
                    if is_nonempty_string(v):
                        env_cfg[k] = env_ref(k)

config_path.write_text(json.dumps(data, indent=2))
PY

echo "Backup written to: $BACKUP_PATH"
echo "Sanitized: $CONFIG_PATH"
