---
summary: "WeChat support on Linux desktop via PyWxDump bridge"
read_when:
  - Setting up WeChat on a Linux gateway host
  - Checking what the bundled WeChat channel supports
title: "WeChat Linux Desktop"
---

# WeChat Linux Desktop

Status: bundled channel for the official Linux desktop WeChat client via a local PyWxDump bridge.
Supports direct messages and groups with text, images, and files.

## Requirements

- Linux host running the official desktop WeChat client and signed in.
- X11 or Xwayland session. Pure Wayland is not supported in v1.
- A local PyWxDump checkout on the same host as the gateway.
- A readable WeChat key file and decrypted database access prepared for PyWxDump.
- `xdotool` available on the gateway host.
- `silk-python` installed in the same Python environment as PyWxDump when you want SILK voice messages to reach ASR.

## Linux package and Python requirements

To run the full WeChat Linux flow on Ubuntu or Debian-like hosts, the practical checklist is:

- Node.js 22+ with `corepack` enabled for OpenClaw.
- A Python 3 virtual environment for PyWxDump.
- System tools for X11 send and screenshot flows:
  - `xdotool`
  - `xclip`
  - `xwininfo`
  - `xwd`
  - `ffmpeg`
  - `xauth`
  - `zstd` recommended
  - `sqlite3` recommended for manual verification
- Python packages in the same environment as `channels.wechat-linux.pythonPath`:
  - `pycryptodomex`
  - `Pillow`
  - `silk-python`
  - `zstandard` recommended
  - `html2text` recommended when `linkDocs` is enabled
  - `beautifulsoup4` recommended when `linkDocs` is enabled

Ubuntu example:

```bash
sudo apt-get update
sudo apt-get install -y xdotool xclip x11-utils x11-apps ffmpeg xauth zstd sqlite3
```

Python example:

```bash
"/path/to/PyWxDump/.venv/bin/python" -m pip install -r \
  "/path/to/openclaw/extensions/wechat-linux/bridge/requirements-linux.txt"
```

The curated Python requirements file lives at:

- `extensions/wechat-linux/bridge/requirements-linux.txt`

## Quick setup

1. Install and sign in to the Linux desktop WeChat client.
2. Prepare PyWxDump on the gateway host and confirm it can extract keys and read local chat data.
3. Configure `channels.wechat-linux`.
4. Probe the bridge:

```bash
openclaw channels status --probe
```

Minimal config:

```json5
{
  channels: {
    "wechat-linux": {
      enabled: true,
      pyWxDumpRoot: "/opt/PyWxDump",
      pythonPath: "python3",
      keyFile: "/home/user/.wx_db_keys.json",
      outputDir: "/home/user/wechat-decrypted",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["wxid_example123"],
      groupAllowFrom: ["wxid_example123"],
    },
  },
}
```

Recommended environment variables for full media processing and send reliability:

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://coding.dashscope.aliyuncs.com/v1"
export OPENAI_MODEL="qwen3-coder-plus"
export MAIN_WINDOW_VISION_BASE_URL="https://coding.dashscope.aliyuncs.com/v1"
export MAIN_WINDOW_VISION_MODEL="qwen3.5-plus"
export DISPLAY=":1.0"
# export XAUTHORITY="/run/user/1000/gdm/Xauthority"
```

Recommended `channels.wechat-linux` config for a full setup:

```json5
{
  channels: {
    "wechat-linux": {
      enabled: true,
      pyWxDumpRoot: "/path/to/PyWxDump",
      pythonPath: "/path/to/PyWxDump/.venv/bin/python",
      keyFile: "/home/user/.wx_db_keys.json",
      dbDir: "/home/user/Documents/xwechat_files/wxid_example/db_storage",
      outputDir: "/home/user/wx_decrypted",
      display: ":1.0",
      windowClass: "wechat",
      windowMode: "auto",
      dmPolicy: "pairing",
      allowFrom: ["wxid_example123"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["wxid_example123"],
      imageAnalysis: true,
      videoAnalysis: true,
      voiceAsr: true,
      linkDocs: true,
      asrUrl: "http://127.0.0.1:8001/api/asr/transcribe",
    },
  },
}
```

## Runtime commands

Typical local development run command for the OpenClaw gateway:

```bash
npx -y node@22 /usr/local/bin/corepack pnpm openclaw gateway run --bind loopback --port 18789 --force
```

Typical `wechat-linux` bridge watch command after the gateway expands the channel config:

```bash
"/path/to/PyWxDump/.venv/bin/python" \
  "/path/to/openclaw/extensions/wechat-linux/bridge/wechat_linux_bridge.py" watch \
  --pywxdump-root "/path/to/PyWxDump" \
  --key-file "$HOME/.wx_db_keys.json" \
  --output-dir "$HOME/wx_decrypted" \
  --window-class wechat \
  --window-mode auto \
  --db-dir "/path/to/xwechat_files/<wxid>/db_storage" \
  --display ":1.0"
```

In normal use you only launch the gateway command. The bridge command is started by the gateway.

## What this channel does

- Watches Linux desktop WeChat chats through a Python bridge.
- Enriches inbound voice, image, video, and link messages before handing them to the agent.
- Normalizes inbound messages into OpenClaw sessions and routes them to the configured agent.
- Sends final agent replies back to WeChat as text, images, or files.
- Keeps DM pairing and group mention safety behavior aligned with other OpenClaw channels.
- Registers WeChat history search tools for messages, files, and images.

## Why `contact.db` matters

The bridge decrypts `contact/contact.db` on startup and uses it to:

- build the contact cache for sender ids and display names
- resolve manual send targets by display name
- normalize group and direct chat metadata before routing into OpenClaw

If `contact.db` cannot be decrypted, the bridge cannot build a stable contact map. In practice that means `probe` fails or `watch` exits before normal message routing starts.

Common symptoms:

- PyWxDump prints `[*] 解密 contact.db ...` followed by `[-] contact.db 解密失败`
- `openclaw channels status --probe` shows a bridge error such as `contact_db_decrypt_failed`
- message routing works on one machine but fails on another after copying an old key file

## Portable `contact.db` recovery checklist

Use this when you move the setup to another Linux host or when WeChat starts using a different local account directory.

1. Find the active `db_storage` directory.
2. Regenerate `~/.wx_db_keys.json` against that exact directory.
3. Decrypt and verify `contact.db` before starting OpenClaw.
4. Pin `channels.wechat-linux.dbDir` so later restarts do not pick a stale directory.

### 1. Find the active `db_storage`

Auto-discovery usually checks these locations:

- `~/Documents/xwechat_files/<wxid_...>/db_storage`
- `~/xwechat_files/<wxid_...>/db_storage`

If the host has multiple `wxid_*` directories, do not rely on the oldest or alphabetically first directory. Use the directory opened by the currently running `wechat` process, then set it explicitly in config.

Example:

```bash
python3 - <<'PY'
import os
import subprocess

result = subprocess.run(["pgrep", "-x", "wechat"], capture_output=True, text=True, check=False)
seen = {}
for raw_pid in result.stdout.split():
    fd_dir = f"/proc/{raw_pid}/fd"
    if not os.path.isdir(fd_dir):
        continue
    for fd_name in os.listdir(fd_dir):
        try:
            target = os.readlink(os.path.join(fd_dir, fd_name)).replace(" (deleted)", "")
        except OSError:
            continue
        marker = "/db_storage/"
        if marker in target and target.endswith(".db"):
            db_dir = f"{target.split(marker, 1)[0]}{marker[:-1]}"
            seen[db_dir] = seen.get(db_dir, 0) + 1
for path, count in sorted(seen.items(), key=lambda item: (-item[1], item[0])):
    print(count, path)
PY
```

### 2. Regenerate the key file

PyWxDump stores derived keys in `~/.wx_db_keys.json`. Those keys are tied to the actual encrypted databases, so copying an old file from another host or another WeChat account directory often causes `contact.db` decryption failures.

The usual recovery flow is:

```bash
cd "/path/to/PyWxDump"
sudo sysctl kernel.yama.ptrace_scope=0
python3 tools/linux_get_wx_key.py --db-dir "/home/user/Documents/xwechat_files/wxid_example/db_storage"
sudo sysctl kernel.yama.ptrace_scope=1
```

Notes:

- Only lower `kernel.yama.ptrace_scope` long enough to extract keys.
- Restore the original value immediately after extraction.
- If the host already runs WeChat with a different active account directory, regenerate the key file again for that directory.

### 3. Verify `contact.db` before starting OpenClaw

Do not assume a fresh key file is correct. Verify it by decrypting and opening `contact.db` directly:

```bash
cd "/path/to/PyWxDump"
python3 tools/linux_decrypt_wx_db.py \
  --key-file "$HOME/.wx_db_keys.json" \
  --db-dir "/home/user/Documents/xwechat_files/wxid_example/db_storage" \
  --output "$HOME/wx_decrypted"

sqlite3 "$HOME/wx_decrypted/contact/contact.db" "SELECT count(*) FROM contact;"
```

If the SQLite query works, the key file and `dbDir` match the live account directory.

### 4. Pin the OpenClaw config

Once you know the right directory, keep OpenClaw on that directory instead of relying on automatic fallback:

```bash
openclaw config set channels.wechat-linux.keyFile "$HOME/.wx_db_keys.json"
openclaw config set channels.wechat-linux.outputDir "$HOME/wx_decrypted"
openclaw config set channels.wechat-linux.dbDir "/home/user/Documents/xwechat_files/wxid_example/db_storage"
openclaw channels status --probe
```

This is especially important on machines that have:

- multiple `wxid_*` directories under `xwechat_files`
- copied backups from another host
- stale databases from an old login

## Portable install notes

When moving this setup to another machine, the safest assumption is:

- `pythonPath` may change
- `dbDir` may change
- `~/.wx_db_keys.json` must be regenerated
- `outputDir` can be reused, but its decrypted files should be treated as disposable cache

The shortest reliable bring-up order is:

1. Install WeChat and sign in.
2. Confirm the active `db_storage`.
3. Regenerate `~/.wx_db_keys.json`.
4. Decrypt and verify `contact.db`.
5. Update `channels.wechat-linux.pythonPath`, `keyFile`, `outputDir`, and `dbDir`.
6. Run `openclaw channels status --probe`.

## Access control

DMs:

- Default: `channels.wechat-linux.dmPolicy = "pairing"`.
- Unknown senders receive a pairing challenge and are blocked until approved.
- `allowFrom` entries should use stable sender ids such as `wxid_*`.
- `open` should only be used together with `allowFrom: ["*"]`.

Groups:

- Default: `channels.wechat-linux.groupPolicy = "allowlist"`.
- `groupAllowFrom` allowlists group senders by sender id, not by room id.
- Group messages are mention-gated in v1 unless the sender is issuing an authorized control command.

## Target formats

Manual sends can target:

- Direct ids: `wechat-linux:user:wxid_example123`
- Group ids: `wechat-linux:group:123456789@chatroom`
- Plain ids: `wxid_example123` or `123456789@chatroom`
- Display names: supported when the bridge can resolve them uniquely

## Capabilities

| Feature         | Status              |
| --------------- | ------------------- |
| Direct messages | Supported           |
| Groups          | Supported           |
| Text            | Supported           |
| Images          | Supported           |
| Files           | Supported           |
| Threads         | Not supported       |
| Reactions       | Not supported       |
| Voice           | Supported via ASR   |
| Video           | Best effort summary |
| Search actions  | Supported           |

## Notes

- This channel is different from the community WeChatPadPro plugin listed on [Community plugins](/plugins/community).
- The bridge needs readable local media files to attach inbound images and files. If a file cannot be materialized locally, the message still reaches the agent as text metadata.
- Outbound streaming is blocked. Only final replies are sent to WeChat.
- `windowMode` defaults to `auto`. Use `standalone` or `main` only when you need to force a specific desktop window flow.

## Rich media conversion

Inbound rich media is converted before the OpenClaw agent sees it:

- Voice: WeChat transcript when available, otherwise optional ASR through `asrUrl`
- Images: OCR or caption text through the configured vision endpoint
- Videos: thumbnail or frame summary when video analysis is enabled
- Links: URL extraction plus optional local document bundle generation through `link_doc_hook.py`

The converted summary is appended to the inbound body together with useful local artifact paths, so the agent can both read the extracted text and access the downloaded file when needed.

For Linux desktop WeChat voice messages, the most common missing dependency is `silk-python` in the PyWxDump virtual environment. When that dependency is missing, `voiceAsr` can still be enabled in config, but SILK attachments cannot be decoded into WAV for the ASR service. `openclaw channels status --probe` now reports this as `silk_python_available`.

## Search tools

The bundled `wechat-linux` plugin registers these agent tools:

- `wechat_search_messages`
- `wechat_search_files`
- `wechat_search_images`

Each tool can search one chat or all chats, with optional `query`, `chat`, `limit`, and `scan_limit` parameters.

## Configuration reference

Provider options:

- `channels.wechat-linux.enabled`: enable or disable channel startup.
- `channels.wechat-linux.pyWxDumpRoot`: path to the local PyWxDump checkout.
- `channels.wechat-linux.pythonPath`: Python executable for the bridge.
- `channels.wechat-linux.keyFile`: path to the PyWxDump key file.
- `channels.wechat-linux.dbDir`: optional override for the WeChat database directory.
- `channels.wechat-linux.outputDir`: writable directory for decrypted and extracted artifacts.
- `channels.wechat-linux.display`: optional `DISPLAY` override for GUI send flows.
- `channels.wechat-linux.xauthority`: optional `XAUTHORITY` override for GUI send flows.
- `channels.wechat-linux.windowClass`: desktop window class to target.
- `channels.wechat-linux.windowMode`: `auto | standalone | main`.
- `channels.wechat-linux.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.wechat-linux.allowFrom`: DM allowlist by sender id.
- `channels.wechat-linux.groupPolicy`: `allowlist | open | disabled`.
- `channels.wechat-linux.groupAllowFrom`: group sender allowlist by sender id.
- `channels.wechat-linux.mentionPatterns`: mention aliases for group gating.
- `channels.wechat-linux.textChunkLimit`: outbound text chunk limit.
- `channels.wechat-linux.blockStreaming`: disable block streaming for this channel.
- `channels.wechat-linux.mediaMaxMb`: inbound and outbound media cap in MB.
- `channels.wechat-linux.imageAnalysis`: enable inbound image OCR or caption analysis.
- `channels.wechat-linux.videoAnalysis`: enable inbound video frame or thumbnail analysis.
- `channels.wechat-linux.voiceAsr`: enable inbound audio transcription through `asrUrl`.
- `channels.wechat-linux.linkDocs`: enable inbound link to document conversion.
- `channels.wechat-linux.visionBaseUrl`: OpenAI-compatible or Anthropic-compatible vision endpoint for image or video analysis.
- `channels.wechat-linux.visionModel`: model id used for image or video analysis.
- `channels.wechat-linux.visionApiKeyEnv`: API key environment variable name for the vision endpoint.
- `channels.wechat-linux.summaryBaseUrl`: optional summary endpoint override for media or chat summarization.
- `channels.wechat-linux.summaryModel`: optional summary model override.
- `channels.wechat-linux.summaryApiKeyEnv`: optional API key environment variable name for summary calls.
- `channels.wechat-linux.asrUrl`: HTTP endpoint used for voice transcription.
- `channels.wechat-linux.linkHookCmd`: override for the link-to-document hook command.
- `channels.wechat-linux.linkDocRoot`: root directory for generated link document bundles.
- `channels.wechat-linux.linkDomains`: allowed link domains for automatic document generation.
- `channels.wechat-linux.linkHookTimeoutSec`: timeout for the link document hook.
- `channels.wechat-linux.accounts.<id>.*`: per-account overrides for all fields above.
