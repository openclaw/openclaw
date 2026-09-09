---
summary: "Install the iMessage plugin, set up imsg on the Messages Mac, and grant macOS permissions"
read_when:
  - Setting up the iMessage channel for the first time
  - Running the Gateway against a remote Messages Mac
  - Granting Full Disk Access and Automation
title: "iMessage setup"
sidebarTitle: "Setup"
---

Install the plugin, install and verify `imsg` on the signed-in Messages Mac, configure the channel, and grant the macOS permissions it needs.

## Install the plugin

Install the official iMessage plugin on the Gateway host, then restart the Gateway:

```bash
openclaw plugins install @openclaw/imessage
```

<CardGroup cols={3}>
  <Card title="Private API actions" icon="wand-sparkles" href="/channels/imessage/rich-messages#private-api-actions">
    Replies, tapbacks, effects, polls, attachments, and group management.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    iMessage DMs default to pairing mode.
  </Card>
  <Card title="Remote Mac" icon="terminal" href="#remote-mac-over-ssh">
    Use an SSH wrapper when the Gateway is not running on the Messages Mac.
  </Card>
  <Card title="Configuration reference" icon="settings" href="/gateway/config-channels#imessage">
    Full iMessage field reference.
  </Card>
</CardGroup>

## Quick setup

<Tabs>
  <Tab title="Local Mac (fast path)">
    <Steps>
      <Step title="Install and verify imsg">

```bash
brew install steipete/tap/imsg
brew update && brew upgrade imsg
imsg rpc --help
imsg launch
openclaw channels status --probe
```

        When the local setup wizard detects a missing default `imsg` command, it can prompt to install `steipete/tap/imsg` through Homebrew. If it detects a Homebrew-managed `imsg`, it can prompt to reinstall or update it. Custom `cliPath` wrappers are not modified.

      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/user/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>

      <Step title="Approve first DM pairing (default dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        Pairing requests expire after 1 hour.
      </Step>
    </Steps>

  </Tab>

  <Tab title="Remote Mac over SSH">
    Most setups do not need SSH. Use this topology only when the Gateway cannot run on the signed-in Messages Mac. Point `cliPath` at a stdio-compatible wrapper on the **Gateway host** that SSHes to the Messages Mac and runs `imsg`. Use the wrapper's absolute path so service launches do not depend on shell home expansion.
    Install and update `imsg` on that remote Mac, not on the Gateway host:

```bash
ssh messages-mac 'brew install steipete/tap/imsg && brew update && brew upgrade imsg'
```

```bash
#!/usr/bin/env bash
exec ssh -T messages-mac imsg "$@"
```

    Recommended config when attachments are enabled:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/home/openclaw/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@messages-mac", // Mac that runs Messages.app and imsg
      // This path is interpreted on the Messages Mac, not on the Gateway host.
      dbPath: "/Users/user/Library/Messages/chat.db",
      includeAttachments: true,
      // Optional: extra allowed attachment roots (merged with the default
      // /Users/*/Library/Messages/Attachments).
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    `remoteHost` identifies the Messages Mac. OpenClaw uses it for both inbound attachment fetches and outbound attachment staging. For outbound files, OpenClaw creates an owner-only temporary path on that Mac, copies the file over the existing strict SSH/SCP transport, passes only the remote path to `imsg`, and attempts removal after success, failure, or timeout. A failed cleanup SSH call emits a warning and can leave the owner-only temporary directory behind.

    An explicit `remoteHost` is recommended and wins when set. For compatibility, OpenClaw auto-detects the existing transparent `exec ssh ... imsg "$@"` wrapper shape once per process and reuses that host across monitoring, probes, sends, and private actions. Auto-detection covers only the simple documented transparent wrapper; option-rich wrappers such as ProxyJump/ProxyCommand must configure `remoteHost`.
    `remoteHost` must be `host` or `user@host` (no spaces or SSH options); unsafe values are ignored.
    OpenClaw uses strict host-key checking for SSH/SCP, so the Messages Mac host key must already exist in `~/.ssh/known_hosts` on the Gateway host.
    Attachment paths are validated against allowed roots (`attachmentRoots` / `remoteAttachmentRoots`).

<Warning>
Any `cliPath` wrapper or SSH proxy you put in front of `imsg` MUST behave like a transparent stdio pipe for long-lived JSON-RPC. OpenClaw exchanges small newline-framed JSON-RPC messages over the wrapper's stdin/stdout for the lifetime of the channel:

- Forward each stdin chunk/line **as soon as bytes are available** — don't wait for EOF.
- Forward each stdout chunk/line promptly in the reverse direction.
- Preserve newlines.
- Avoid fixed-size blocking reads (`read(4096)`, `cat | buffer`, default shell `read`) that can starve small frames.
- Keep stderr separate from the JSON-RPC stdout stream.

A wrapper that buffers stdin until a large block fills will produce symptoms that look like an iMessage outage — `imsg rpc timeout (chats.list)` or repeated channel restarts — even though `imsg rpc` itself is healthy. `ssh -T host imsg "$@"` (above) is safe because it forwards OpenClaw's `cliPath` arguments such as `rpc` and `--db`. Pipelines like `ssh host imsg | grep -v '^DEBUG'` are NOT — line-buffered tools can still hold frames; use `stdbuf -oL -eL` on every stage if you must filter.
</Warning>

  </Tab>
</Tabs>

## Requirements and permissions (macOS)

- Messages must be signed in on the Mac running `imsg`.
- Full Disk Access is required for the process context running OpenClaw/`imsg` (Messages DB access).
- Automation permission is required to send messages through Messages.app.
- For advanced actions (react / edit / unsend / threaded reply / effects / polls / group ops), System Integrity Protection must be disabled — see [Enabling the imsg private API](/channels/imessage/private-api#enabling-the-imsg-private-api). Basic text and media send/receive work without it.

<Tip>
Permissions are granted per process context. If the gateway runs headless (LaunchAgent/SSH), run a one-time interactive command in that same context to trigger prompts:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

</Tip>

<Accordion title="SSH wrapper sends fail with AppleEvents -1743">
  A remote-SSH setup can read chats, pass `channels status --probe`, and process inbound messages while outbound sends still fail with an AppleEvents authorization error:

```text
Not authorized to send Apple events to Messages. (-1743)
```

Check the signed-in Mac user's TCC database or System Settings > Privacy & Security > Automation. If the Automation entry is recorded for `/usr/libexec/sshd-keygen-wrapper` instead of the `imsg` or local shell process, macOS may not expose a usable Messages toggle for that SSH server-side client:

```text
kTCCServiceAppleEvents | /usr/libexec/sshd-keygen-wrapper | auth_value=0 | com.apple.MobileSMS
```

In that state, repeating `tccutil reset AppleEvents` or rerunning `imsg send` through the same SSH wrapper may keep failing because the process context that needs Messages Automation is the SSH wrapper, not an app the UI can grant.

Use one of the supported `imsg` process contexts instead:

- Run the Gateway, or at least the `imsg` bridge, in the logged-in Messages user's local session.
- Start the Gateway with a LaunchAgent for that user after granting Full Disk Access and Automation from the same session.
- If you keep the two-user SSH topology, verify that a real outbound `imsg send` succeeds through the exact wrapper before enabling the channel. If it cannot be granted Automation, reconfigure to a single-user `imsg` setup instead of relying on the SSH wrapper for sends.

</Accordion>
