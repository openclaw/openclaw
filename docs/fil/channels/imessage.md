---
summary: "46. Legacy na suporta sa iMessage sa pamamagitan ng imsg (JSON-RPC sa stdio). 47. Ang mga bagong setup ay dapat gumamit ng BlueBubbles."
read_when:
  - Pagse-setup ng suporta sa iMessage
  - Pag-debug ng pagpapadala/pagtanggap ng iMessage
title: iMessage
---

# iMessage (legacy: imsg)

> **Inirerekomenda:** Gamitin ang [BlueBubbles](/channels/bluebubbles) para sa mga bagong setup ng iMessage.
>
> Ang channel na `imsg` ay isang legacy na external-CLI integration at maaaring alisin sa mga susunod na release.

48. Status: legacy external CLI integration. 49. Ang gateway ay nag-i-spawn ng `imsg rpc` (JSON-RPC sa stdio).

## Quick setup (beginner)

1. Tiyaking naka-sign in ang Messages sa Mac na ito.
2. I-install ang `imsg`:
   - `brew install steipete/tap/imsg`
3. I-configure ang OpenClaw gamit ang `channels.imessage.cliPath` at `channels.imessage.dbPath`.
4. Simulan ang gateway at aprubahan ang anumang macOS prompt (Automation + Full Disk Access).

Minimal na config:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Ano ito

- iMessage channel na naka-back sa `imsg` sa macOS.
- Deterministic routing: ang mga reply ay palaging bumabalik sa iMessage.
- Ang mga DM ay nagbabahagi ng pangunahing session ng agent; ang mga group ay hiwalay (`agent:<agentId>:imessage:group:<chat_id>`).
- Kung may dumating na multi-participant thread na may `is_group=false`, maaari mo pa rin itong ihiwalay sa pamamagitan ng `chat_id` gamit ang `channels.imessage.groups` (tingnan ang “Group-ish threads” sa ibaba).

## Config writes

Bilang default, pinapayagan ang iMessage na magsulat ng mga update sa config na na-trigger ng `/config set|unset` (nangangailangan ng `commands.config: true`).

I-disable gamit ang:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Mga kinakailangan

- macOS na naka-sign in ang Messages.
- Full Disk Access para sa OpenClaw + `imsg` (access sa Messages DB).
- Automation permission kapag nagpapadala.
- Maaaring ituro ang `channels.imessage.cliPath` sa anumang command na nagpo-proxy ng stdin/stdout (halimbawa, isang wrapper script na nag-SSH sa ibang Mac at nagpapatakbo ng `imsg rpc`).

## Pag-troubleshoot sa macOS Privacy and Security TCC

Kung pumalya ang pagpapadala/pagtanggap (halimbawa, nag-e-exit ang `imsg rpc` na may non-zero, nagti-time out, o tila nagha-hang ang gateway), karaniwang sanhi nito ang macOS permission prompt na hindi naaprubahan.

50. Ang macOS ay nagbibigay ng TCC permissions per app/process context. Approve prompts in the same context that runs `imsg` (for example, Terminal/iTerm, a LaunchAgent session, or an SSH-launched process).

Checklist:

- **Full Disk Access**: allow access for the process running OpenClaw (and any shell/SSH wrapper that executes `imsg`). Ito ay kinakailangan upang mabasa ang Messages database (`chat.db`).
- **Automation → Messages**: payagan ang prosesong nagpapatakbo ng OpenClaw (at/o ang iyong terminal) na kontrolin ang **Messages.app** para sa outbound na pagpapadala.
- **`imsg` CLI health**: tiyaking naka-install ang `imsg` at sumusuporta sa RPC (`imsg rpc --help`).

Tip: Kung ang OpenClaw ay tumatakbo nang headless (LaunchAgent/systemd/SSH), maaaring madaling makaligtaan ang macOS prompt. Run a one-time interactive command in a GUI terminal to force the prompt, then retry:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Mga kaugnay na pahintulot sa macOS folder (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## Setup (fast path)

1. Tiyaking naka-sign in ang Messages sa Mac na ito.
2. I-configure ang iMessage at simulan ang gateway.

### Dedicated bot macOS user (para sa hiwalay na identity)

Kung gusto mong magpadala ang bot mula sa **hiwalay na iMessage identity** (at manatiling malinis ang iyong personal na Messages), gumamit ng dedicated Apple ID + dedicated macOS user.

1. Gumawa ng dedicated Apple ID (halimbawa: `my-cool-bot@icloud.com`).
   - Maaaring mangailangan ang Apple ng phone number para sa verification / 2FA.
2. Gumawa ng macOS user (halimbawa: `openclawhome`) at mag-sign in dito.
3. Buksan ang Messages sa macOS user na iyon at mag-sign in sa iMessage gamit ang bot Apple ID.
4. I-enable ang Remote Login (System Settings → General → Sharing → Remote Login).
5. I-install ang `imsg`:
   - `brew install steipete/tap/imsg`
6. I-set up ang SSH para gumana ang `ssh <bot-macos-user>@localhost true` nang walang password.
7. Ituro ang `channels.imessage.accounts.bot.cliPath` sa isang SSH wrapper na nagpapatakbo ng `imsg` bilang bot user.

First-run note: sending/receiving may require GUI approvals (Automation + Full Disk Access) in the _bot macOS user_. Kung mukhang naka-stuck o biglang nag-e-exit ang `imsg rpc`, mag-log in sa user na iyon (nakakatulong ang Screen Sharing), magpatakbo ng one-time `imsg chats --limit 1` / `imsg send ...`, aprubahan ang mga prompt, saka subukang muli. See [Troubleshooting macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc).

Example wrapper (`chmod +x`). Replace `<bot-macos-user>` with your actual macOS username:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Halimbawang config:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Para sa mga single-account setup, gumamit ng flat options (`channels.imessage.cliPath`, `channels.imessage.dbPath`) sa halip na ang `accounts` map.

### Remote/SSH variant (opsyonal)

If you want iMessage on another Mac, set `channels.imessage.cliPath` to a wrapper that runs `imsg` on the remote macOS host over SSH. Kailangan lang ng OpenClaw ang stdio.

Halimbawang wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Remote attachments:** When `cliPath` points to a remote host via SSH, attachment paths in the Messages database reference files on the remote machine. OpenClaw can automatically fetch these over SCP by setting `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

If `remoteHost` is not set, OpenClaw attempts to auto-detect it by parsing the SSH command in your wrapper script. Explicit configuration is recommended for reliability.

#### Remote Mac sa pamamagitan ng Tailscale (halimbawa)

Kung tumatakbo ang Gateway sa isang Linux host/VM ngunit kailangang tumakbo ang iMessage sa Mac, ang Tailscale ang pinakasimpleng tulay: nakikipag-usap ang Gateway sa Mac sa pamamagitan ng tailnet, pinapatakbo ang `imsg` via SSH, at kinokopya ang mga attachment pabalik sa SCP.

Arkitektura:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Konkretong halimbawang config (Tailscale hostname):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Halimbawang wrapper (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Mga tala:

- Tiyaking naka-sign in ang Mac sa Messages, at naka-enable ang Remote Login.
- Gumamit ng SSH keys para gumana ang `ssh bot@mac-mini.tailnet-1234.ts.net` nang walang mga prompt.
- Dapat tumugma ang `remoteHost` sa SSH target para makuha ng SCP ang mga attachment.

Multi-account support: gamitin ang `channels.imessage.accounts` na may per-account config at opsyonal na `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern. Don't commit `~/.openclaw/openclaw.json` (it often contains tokens).

## Kontrol sa access (DMs + groups)

DMs:

- Default: `channels.imessage.dmPolicy = "pairing"`.
- Ang mga hindi kilalang sender ay makakatanggap ng pairing code; hindi papansinin ang mga mensahe hanggang maaprubahan (nag-e-expire ang mga code pagkalipas ng 1 oras).
- Aprubahan sa pamamagitan ng:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Pairing is the default token exchange for iMessage DMs. Details: [Pairing](/channels/pairing)

Groups:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- Kinokontrol ng `channels.imessage.groupAllowFrom` kung sino ang maaaring mag-trigger sa mga group kapag naka-set ang `allowlist`.
- Gumagamit ang mention gating ng `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) dahil walang native na mention metadata ang iMessage.
- Multi-agent override: mag-set ng per-agent patterns sa `agents.list[].groupChat.mentionPatterns`.

## Paano ito gumagana (behavior)

- Nag-i-stream ang `imsg` ng mga event ng mensahe; ginagawa ng gateway na normalisado ang mga ito sa shared channel envelope.
- Ang mga reply ay palaging niruruta pabalik sa parehong chat id o handle.

## Group-ish threads (`is_group=false`)

May ilang iMessage thread na maaaring may maraming participant ngunit dumarating pa rin na may `is_group=false` depende sa kung paano ini-store ng Messages ang chat identifier.

Kung tahasan kang mag-configure ng `chat_id` sa ilalim ng `channels.imessage.groups`, ituturing ng OpenClaw ang thread na iyon bilang isang “group” para sa:

- session isolation (hiwalay na `agent:<agentId>:imessage:group:<chat_id>` session key)
- group allowlisting / mention gating behavior

Halimbawa:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

This is useful when you want an isolated personality/model for a specific thread (see [Multi-agent routing](/concepts/multi-agent)). For filesystem isolation, see [Sandboxing](/gateway/sandboxing).

## Media + limits

- Opsyonal na attachment ingestion sa pamamagitan ng `channels.imessage.includeAttachments`.
- Media cap sa pamamagitan ng `channels.imessage.mediaMaxMb`.

## Mga limitasyon

- Ang outbound na text ay hinahati sa `channels.imessage.textChunkLimit` (default 4000).
- Opsyonal na newline chunking: itakda ang `channels.imessage.chunkMode="newline"` para hatiin sa mga blankong linya (mga hangganan ng talata) bago ang length chunking.
- Ang mga media upload ay nililimitahan ng `channels.imessage.mediaMaxMb` (default 16).

## Addressing / delivery targets

Mas piliin ang `chat_id` para sa stable na routing:

- `chat_id:123` (inirerekomenda)
- `chat_guid:...`
- `chat_identifier:...`
- mga direktang handle: `imessage:+1555` / `sms:+1555` / `user@example.com`

Ilista ang mga chat:

```
imsg chats --limit 20
```

## Configuration reference (iMessage)

Buong configuration: [Configuration](/gateway/configuration)

Mga opsyon ng provider:

- `channels.imessage.enabled`: i-enable/i-disable ang startup ng channel.
- `channels.imessage.cliPath`: path papunta sa `imsg`.
- `channels.imessage.dbPath`: path ng Messages DB.
- `channels.imessage.remoteHost`: SSH host for SCP attachment transfer when `cliPath` points to a remote Mac (e.g., `user@gateway-host`). Auto-detected from SSH wrapper if not set.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: SMS region.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.imessage.allowFrom`: DM allowlist (handles, emails, E.164 numbers, or `chat_id:*`). `open` requires `"*"`. iMessage has no usernames; use handles or chat targets.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (default: allowlist).
- `channels.imessage.groupAllowFrom`: group sender allowlist.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: max na mga group message na isasama bilang context (0 ay nagdi-disable).
- `channels.imessage.dmHistoryLimit`: limit ng DM history sa bilang ng user turns. Per-user overrides: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: per-group defaults + allowlist (gamitin ang `"*"` para sa global defaults).
- `channels.imessage.includeAttachments`: i-ingest ang mga attachment sa context.
- `channels.imessage.mediaMaxMb`: inbound/outbound media cap (MB).
- `channels.imessage.textChunkLimit`: outbound chunk size (chars).
- `channels.imessage.chunkMode`: `length` (default) o `newline` para hatiin sa mga blankong linya (mga hangganan ng talata) bago ang length chunking.

Mga kaugnay na global na opsyon:

- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
