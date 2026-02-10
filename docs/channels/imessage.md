---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Legacy iMessage support via imsg (JSON-RPC over stdio). New setups should use BlueBubbles."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up iMessage support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging iMessage send/receive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: iMessage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# iMessage (legacy: imsg)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Recommended:** Use [BlueBubbles](/channels/bluebubbles) for new iMessage setups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> The `imsg` channel is a legacy external-CLI integration and may be removed in a future release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: legacy external CLI integration. Gateway spawns `imsg rpc` (JSON-RPC over stdio).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure Messages is signed in on this Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Install `imsg`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `brew install steipete/tap/imsg`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Configure OpenClaw with `channels.imessage.cliPath` and `channels.imessage.dbPath`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Start the gateway and approve any macOS prompts (Automation + Full Disk Access).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliPath: "/usr/local/bin/imsg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dbPath: "/Users/<you>/Library/Messages/chat.db",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage channel backed by `imsg` on macOS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic routing: replies always go back to iMessage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs share the agent's main session; groups are isolated (`agent:<agentId>:imessage:group:<chat_id>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a multi-participant thread arrives with `is_group=false`, you can still isolate it by `chat_id` using `channels.imessage.groups` (see “Group-ish threads” below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, iMessage is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { imessage: { configWrites: false } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS with Messages signed in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full Disk Access for OpenClaw + `imsg` (Messages DB access).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Automation permission when sending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.cliPath` can point to any command that proxies stdin/stdout (for example, a wrapper script that SSHes to another Mac and runs `imsg rpc`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting macOS Privacy and Security TCC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If sending/receiving fails (for example, `imsg rpc` exits non-zero, times out, or the gateway appears to hang), a common cause is a macOS permission prompt that was never approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS grants TCC permissions per app/process context. Approve prompts in the same context that runs `imsg` (for example, Terminal/iTerm, a LaunchAgent session, or an SSH-launched process).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Checklist:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Full Disk Access**: allow access for the process running OpenClaw (and any shell/SSH wrapper that executes `imsg`). This is required to read the Messages database (`chat.db`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Automation → Messages**: allow the process running OpenClaw (and/or your terminal) to control **Messages.app** for outbound sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`imsg` CLI health**: verify `imsg` is installed and supports RPC (`imsg rpc --help`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: If OpenClaw is running headless (LaunchAgent/systemd/SSH) the macOS prompt can be easy to miss. Run a one-time interactive command in a GUI terminal to force the prompt, then retry:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
imsg chats --limit 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
imsg send <handle> "test"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related macOS folder permissions (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (fast path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Ensure Messages is signed in on this Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Configure iMessage and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Dedicated bot macOS user (for isolated identity)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the bot to send from a **separate iMessage identity** (and keep your personal Messages clean), use a dedicated Apple ID + a dedicated macOS user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a dedicated Apple ID (example: `my-cool-bot@icloud.com`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Apple may require a phone number for verification / 2FA.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a macOS user (example: `openclawhome`) and sign into it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Open Messages in that macOS user and sign into iMessage using the bot Apple ID.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Enable Remote Login (System Settings → General → Sharing → Remote Login).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Install `imsg`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `brew install steipete/tap/imsg`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Set up SSH so `ssh <bot-macos-user>@localhost true` works without a password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Point `channels.imessage.accounts.bot.cliPath` at an SSH wrapper that runs `imsg` as the bot user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
First-run note: sending/receiving may require GUI approvals (Automation + Full Disk Access) in the _bot macOS user_. If `imsg rpc` looks stuck or exits, log into that user (Screen Sharing helps), run a one-time `imsg chats --limit 1` / `imsg send ...`, approve prompts, then retry. See [Troubleshooting macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example wrapper (`chmod +x`). Replace `<bot-macos-user>` with your actual macOS username:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#!/usr/bin/env bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
set -euo pipefail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Run an interactive SSH once first to accept host keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#   ssh <bot-macos-user>@localhost true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "/usr/local/bin/imsg" "$@"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        bot: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          name: "Bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          cliPath: "/path/to/imsg-bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For single-account setups, use flat options (`channels.imessage.cliPath`, `channels.imessage.dbPath`) instead of the `accounts` map.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Remote/SSH variant (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want iMessage on another Mac, set `channels.imessage.cliPath` to a wrapper that runs `imsg` on the remote macOS host over SSH. OpenClaw only needs stdio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example wrapper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#!/usr/bin/env bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exec ssh -T gateway-host imsg "$@"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Remote attachments:** When `cliPath` points to a remote host via SSH, attachment paths in the Messages database reference files on the remote machine. OpenClaw can automatically fetch these over SCP by setting `channels.imessage.remoteHost`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remoteHost: "user@gateway-host", // for SCP file transfer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      includeAttachments: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `remoteHost` is not set, OpenClaw attempts to auto-detect it by parsing the SSH command in your wrapper script. Explicit configuration is recommended for reliability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Remote Mac via Tailscale (example)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs on a Linux host/VM but iMessage must run on a Mac, Tailscale is the simplest bridge: the Gateway talks to the Mac over the tailnet, runs `imsg` via SSH, and SCPs attachments back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Architecture:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```mermaid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
%%{init: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'theme': 'base',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'themeVariables': {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryTextColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryBorderColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'lineColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'secondaryColor': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'tertiaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBkg': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'nodeBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'mainBkg': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'edgeLabelBackground': '#ffffff'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}}%%（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
flowchart TB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
 subgraph T[" "]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
 subgraph Tailscale[" "]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    direction LR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Gateway["<b>Gateway host (Linux/VM)<br></b><br>openclaw gateway<br>channels.imessage.cliPath"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Mac["<b>Mac with Messages + imsg<br></b><br>Messages signed in<br>Remote Login enabled"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway -- SSH (imsg rpc) --> Mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Mac -- SCP (attachments) --> Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    direction BT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    User["user@gateway-host"] -- "Tailscale tailnet (hostname or 100.x.y.z)" --> Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Concrete config example (Tailscale hostname):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliPath: "~/.openclaw/scripts/imsg-ssh",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      includeAttachments: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dbPath: "/Users/bot/Library/Messages/chat.db",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example wrapper (`~/.openclaw/scripts/imsg-ssh`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#!/usr/bin/env bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure the Mac is signed in to Messages, and Remote Login is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use SSH keys so `ssh bot@mac-mini.tailnet-1234.ts.net` works without prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remoteHost` should match the SSH target so SCP can fetch attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support: use `channels.imessage.accounts` with per-account config and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern. Don't commit `~/.openclaw/openclaw.json` (it often contains tokens).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs + groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DMs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.imessage.dmPolicy = "pairing"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list imessage`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve imessage <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing is the default token exchange for iMessage DMs. Details: [Pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Groups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.groupPolicy = open | allowlist | disabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mention gating uses `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) because iMessage has no native mention metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `imsg` streams message events; the gateway normalizes them into the shared channel envelope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies always route back to the same chat id or handle.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group-ish threads (`is_group=false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some iMessage threads can have multiple participants but still arrive with `is_group=false` depending on how Messages stores the chat identifier.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you explicitly configure a `chat_id` under `channels.imessage.groups`, OpenClaw treats that thread as a “group” for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- session isolation (separate `agent:<agentId>:imessage:group:<chat_id>` session key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- group allowlisting / mention gating behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "42": { requireMention: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is useful when you want an isolated personality/model for a specific thread (see [Multi-agent routing](/concepts/multi-agent)). For filesystem isolation, see [Sandboxing](/gateway/sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Media + limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional attachment ingestion via `channels.imessage.includeAttachments`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media cap via `channels.imessage.mediaMaxMb`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to `channels.imessage.textChunkLimit` (default 4000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional newline chunking: set `channels.imessage.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media uploads are capped by `channels.imessage.mediaMaxMb` (default 16).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Addressing / delivery targets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer `chat_id` for stable routing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat_id:123` (preferred)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat_guid:...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat_identifier:...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- direct handles: `imessage:+1555` / `sms:+1555` / `user@example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List chats:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
imsg chats --limit 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (iMessage)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.enabled`: enable/disable channel startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.cliPath`: path to `imsg`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.dbPath`: Messages DB path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.remoteHost`: SSH host for SCP attachment transfer when `cliPath` points to a remote Mac (e.g., `user@gateway-host`). Auto-detected from SSH wrapper if not set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.service`: `imessage | sms | auto`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.region`: SMS region.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.allowFrom`: DM allowlist (handles, emails, E.164 numbers, or `chat_id:*`). `open` requires `"*"`. iMessage has no usernames; use handles or chat targets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (default: allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.groupAllowFrom`: group sender allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: max group messages to include as context (0 disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `channels.imessage.dms["<handle>"].historyLimit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.groups`: per-group defaults + allowlist (use `"*"` for global defaults).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.includeAttachments`: ingest attachments into context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.mediaMaxMb`: inbound/outbound media cap (MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.textChunkLimit`: outbound chunk size (chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related global options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.responsePrefix`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
