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

    If the check reports RPC unsupported, update `imsg`. If private API actions are unavailable, run `imsg launch` in the logged-in macOS user session and check again. If the Gateway is not running on macOS, use the [Remote Mac over SSH](/channels/imessage/setup#remote-mac-over-ssh) setup instead of the default local `imsg` path.

  </Accordion>

  <Accordion title="Replies fail after an app update, but channel status is healthy">
    A successful `channels status --probe` checks RPC/read access, not whether Messages can send. Automation failures can therefore coexist with a healthy probe and working inbound messages.

    For structured AppleScript failures, OpenClaw includes launch-context guidance with the send error. Error `-1743` means Messages Automation was denied. Error `-1712` is an Apple event timeout: a missing grant is one possible cause, not a confirmed diagnosis.

    Check **System Settings → Privacy & Security → Automation** on the Mac running Messages:

    - For a local app-managed Gateway, check the Gateway/launcher process macOS identifies. An app update that switches Node to Bun, or first moves the service to the stable `~/.openclaw/runtime/service/bun` path, needs this grant approved once; later updates keep that path. The error includes the current local Gateway runtime path to help distinguish it from an old entry.
    - For SSH or custom wrappers, check that Mac's actual SSH/wrapper launch context, not the remote Gateway host's runtime.
    - A grant to Terminal or OpenClaw.app does not by itself establish access for a background service.

    Review the required grant in that user session, then verify delivery through the same Gateway and launch context using an explicitly requested test message to a consenting recipient. A Terminal-only test does not validate the background service. Pending replies may drain after recovery; do not resend them manually before checking their delivery outcome.

    See [iMessage permissions](/channels/imessage/setup#requirements-and-permissions-macos) and [Gateway hosting](/platforms/mac/bundled-gateway). Changing a runtime symlink is not a verified permission-continuity fix.

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
    Review Full Disk Access and Messages Automation in the logged-in Messages user’s macOS session for the process context that actually runs OpenClaw/`imsg`. See [Requirements and permissions](/channels/imessage/setup#requirements-and-permissions-macos), including the SSH-wrapper edge case.

    A successful command in Terminal only verifies Terminal’s context. It does not establish permissions for a LaunchAgent or SSH wrapper. Verify the configured Gateway’s send path with an explicitly requested test message, not an automatic health-check send.

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
- [Channel routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
