# Genspark IM

Genspark IM is a messaging channel backed by CometChat and distributed as a workspace plugin.

## Setup

The plugin is installed automatically on Genspark-managed VMs. It reads credentials from `~/.genspark-tool-cli/config.json`.

## Sending Media (`genspark_im_send_media`)

The `genspark_im_send_media` tool sends files to Genspark IM users or groups.

### ⚠️ Known Limitation: Genspark Wrapper URLs (Fixed in v0.7.2)

Genspark file wrapper URLs (`https://www.genspark.ai/api/files/s/...`) require Bearer token
authentication. CometChat fetches `media_url` without credentials and receives HTTP 403,
returning `status=-7`.

**Plugin v0.7.2+ handles this automatically:** The plugin detects wrapper URLs, downloads
the file locally using the GSK token, re-hosts it on the VM's public IP (port 8000), and
passes that public URL to CometChat.

**Root cause:** The server's `/api/im/bot/send_media` endpoint passes `media_url` directly
to CometChat without authentication. Long-term fix: detect wrapper URLs server-side and
proxy-download them internally. See [#58151](https://github.com/openclaw/openclaw/issues/58151).

### Supported URL types

| URL type | Supported |
|----------|-----------|
| Public HTTP/HTTPS | ✅ Always works |
| Genspark wrapper (`/api/files/s/`) | ✅ Plugin v0.7.2+ (client re-hosts) |
| Local file paths | ❌ Use `gsk upload` first |
