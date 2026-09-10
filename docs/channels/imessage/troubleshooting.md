---
summary: "Fixes for a missing imsg binary, silent inbound, ignored DMs and groups, and failed remote attachments"
read_when:
  - Debugging iMessage send or receive
  - Recovering a bridge that stopped delivering messages
title: "iMessage troubleshooting"
sidebarTitle: "Troubleshooting"
---

Symptom-first fixes for the iMessage channel, plus the configuration reference links.

## Troubleshooting

<AccordionGroup>
  <Accordion title="imsg not found or RPC unsupported">
    Validate the binary and RPC support:

    ```bash
    imsg rpc --help
    imsg status --json
    openclaw channels status --probe
    ```

    If the probe reports RPC unsupported, update `imsg`. If private API actions are unavailable, run `imsg launch` in the logged-in macOS user session and probe again. If the Gateway is not running on macOS, use the [Remote Mac over SSH](/channels/imessage/setup#remote-mac-over-ssh) setup instead of the default local `imsg` path.

  </Accordion>

  <Accordion title="Messages send but inbound iMessages do not arrive">
    First prove whether the message reached the local Mac. If `chat.db` does not change, OpenClaw cannot receive the message even when `imsg status --json` reports a healthy bridge.

```bash
imsg chats --limit 10 --json
imsg watch --chat-id <chat-id> --json
sqlite3 ~/Library/Messages/chat.db \
  "select datetime(max(date)/1000000000 + 978307200, 'unixepoch', 'localtime'), max(ROWID) from message;"
```

    If phone-sent messages create no new rows, repair the macOS Messages and Apple Push layer before changing OpenClaw config. A one-shot service refresh is often enough:

```bash
launchctl kickstart -k system/com.apple.apsd
launchctl kickstart -k gui/$(id -u)/com.apple.CommCenter
launchctl kickstart -k gui/$(id -u)/com.apple.identityservicesd
launchctl kickstart -k gui/$(id -u)/com.apple.imagent
imsg launch
openclaw gateway restart
```

    Send a fresh iMessage from the phone and confirm a new `chat.db` row or `imsg watch` event before debugging OpenClaw sessions. Do not run this as a periodic bridge-relaunch loop; repeated `imsg launch` plus gateway restarts during active work can interrupt deliveries and strand in-flight channel runs.

  </Accordion>

  <Accordion title="Gateway is not running on macOS">
    The default `cliPath: "imsg"` must run on the Mac signed into Messages. On Linux or Windows, set `channels.imessage.cliPath` to a wrapper script that SSHes to that Mac and runs `imsg "$@"`.

```bash
#!/usr/bin/env bash
exec ssh -T messages-mac imsg "$@"
```

    Then run:

```bash
openclaw channels status --probe --channel imessage
```

  </Accordion>

  <Accordion title="DMs are ignored">
    Check:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - pairing approvals (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="Group messages are ignored">
    Check:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` allowlist behavior
    - mention gating: explicit patterns or the routed agent's identity name/emoji; set `requireMention: false` for the chat in the effective root or account `groups` map to process all messages from allowed senders

  </Accordion>

  <Accordion title="Remote attachments fail">
    Check:

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - SSH/SCP key auth from the gateway host
    - host key exists in `~/.ssh/known_hosts` on the gateway host
    - remote path readability on the Mac running Messages

  </Accordion>

  <Accordion title="macOS permission prompts were missed">
    Re-run in an interactive GUI terminal in the same user/session context and approve prompts:

    ```bash
    imsg chats --limit 1
    imsg send <handle> "test"
    ```

    Confirm Full Disk Access + Automation are granted for the process context that runs OpenClaw/`imsg`.

  </Accordion>
</AccordionGroup>

## Configuration reference pointers

- [Configuration reference - iMessage](/gateway/config-channels#imessage)
- [Gateway configuration](/gateway/configuration)
- [Pairing](/channels/pairing)

## Related

- [Channels Overview](/channels) — all supported channels
- [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) — announcement and migration summary
- [Coming from BlueBubbles](/channels/imessage-from-bluebubbles) — config translation table and step-by-step cutover
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
