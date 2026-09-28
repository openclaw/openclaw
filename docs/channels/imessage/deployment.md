---
summary: "Dedicated bot macOS user, remote Mac over Tailscale, multi-account, and DM history patterns"
read_when:
  - Choosing where to run the Gateway and imsg
  - Isolating bot traffic from a personal iMessage identity
  - Running more than one iMessage account
title: "iMessage deployment patterns"
sidebarTitle: "Deployment patterns"
---

Topologies for running `imsg` next to a signed-in Messages account, and the config each one needs.

## Deployment patterns

<AccordionGroup>
  <Accordion title="Dedicated bot macOS user (separate iMessage identity)">
    Use a dedicated Apple ID and macOS user so bot traffic is isolated from your personal Messages profile.

    Typical flow:

    1. Create/sign in a dedicated macOS user.
    2. Sign into Messages with the bot Apple ID in that user.
    3. Install `imsg` in that user.
    4. Create an SSH wrapper so OpenClaw can run `imsg` in that user context.
    5. Point `channels.imessage.accounts.<id>.cliPath` and `.dbPath` to that user profile.

    First run may require GUI approvals (Automation + Full Disk Access) in that bot user session.

  </Accordion>

  <Accordion title="Remote Mac over Tailscale (example)">
    Common topology:

    - gateway runs on Linux/VM
    - iMessage + `imsg` runs on a Mac in your tailnet
    - `cliPath` wrapper uses SSH to run `imsg`
    - `remoteHost` enables inbound fetches and owner-only outbound staging over SSH/SCP

    Example:

    ```json5
    {
      channels: {
        imessage: {
          enabled: true,
          cliPath: "/home/openclaw/.openclaw/scripts/imsg-ssh",
          remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
          includeAttachments: true,
          dbPath: "/Users/bot/Library/Messages/chat.db",
        },
      },
    }
    ```

    ```bash
    #!/usr/bin/env bash
    exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
    ```

    `cliPath` is an absolute, Gateway-local wrapper path. `remoteHost` and `dbPath` refer to the Messages Mac; do not rewrite the remote database path using the Gateway user's home directory.

    Use SSH keys so both SSH and SCP are non-interactive.
    Ensure the host key is trusted first (for example `ssh bot@mac-mini.tailnet-1234.ts.net`) so `known_hosts` is populated.

  </Accordion>

  <Accordion title="Multi-account pattern">
    iMessage supports per-account config under `channels.imessage.accounts`.

    Each account can override fields such as `cliPath`, `dbPath`, `allowFrom`, `dmPolicy`, `groupPolicy`, `mediaMaxMb`, history settings, and attachment root allowlists. Omitted account policies inherit the channel root; explicit account policies win. If neither scope sets them, DMs use `pairing` and groups use `allowlist`.

  </Accordion>

  <Accordion title="Direct-message history">
    Set `channels.imessage.dmHistoryLimit` to seed new direct-message sessions with recent decoded `imsg` history for that conversation. Use `channels.imessage.dms["<sender>"].historyLimit` for per-sender overrides, including `0` to disable history for a sender.

    iMessage DM history is fetched on demand from `imsg`. Leaving `dmHistoryLimit` unset disables global DM history seeding, but a positive per-sender `channels.imessage.dms["<sender>"].historyLimit` still enables seeding for that sender.

  </Accordion>
</AccordionGroup>
