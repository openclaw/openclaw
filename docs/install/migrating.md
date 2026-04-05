---
summary: "Move (migrate) an Mullusi install from one machine to another"
read_when:
  - You are moving Mullusi to a new laptop/server
  - You want to preserve sessions, auth, and channel logins (WhatsApp, etc.)
title: "Migration Guide"
---

# Migrating Mullusi to a New Machine

This guide moves an Mullusi gateway to a new machine without redoing onboarding.

## What Gets Migrated

When you copy the **state directory** (`~/.mullusi/` by default) and your **workspace**, you preserve:

- **Config** -- `mullusi.json` and all gateway settings
- **Auth** -- per-agent `auth-profiles.json` (API keys + OAuth), plus any channel/provider state under `credentials/`
- **Sessions** -- conversation history and agent state
- **Channel state** -- WhatsApp login, Telegram session, etc.
- **Workspace files** -- `MEMORY.md`, `USER.md`, skills, and prompts

<Tip>
Run `mullusi status` on the old machine to confirm your state directory path.
Custom profiles use `~/.mullusi-<profile>/` or a path set via `MULLUSI_STATE_DIR`.
</Tip>

## Migration Steps

<Steps>
  <Step title="Stop the gateway and back up">
    On the **old** machine, stop the gateway so files are not changing mid-copy, then archive:

    ```bash
    mullusi gateway stop
    cd ~
    tar -czf mullusi-state.tgz .mullusi
    ```

    If you use multiple profiles (e.g. `~/.mullusi-work`), archive each separately.

  </Step>

  <Step title="Install Mullusi on the new machine">
    [Install](/install) the CLI (and Node if needed) on the new machine.
    It is fine if onboarding creates a fresh `~/.mullusi/` -- you will overwrite it next.
  </Step>

  <Step title="Copy state directory and workspace">
    Transfer the archive via `scp`, `rsync -a`, or an external drive, then extract:

    ```bash
    cd ~
    tar -xzf mullusi-state.tgz
    ```

    Ensure hidden directories were included and file ownership matches the user that will run the gateway.

  </Step>

  <Step title="Run doctor and verify">
    On the new machine, run [Doctor](/gateway/doctor) to apply config migrations and repair services:

    ```bash
    mullusi doctor
    mullusi gateway restart
    mullusi status
    ```

  </Step>
</Steps>

## Common Pitfalls

<AccordionGroup>
  <Accordion title="Profile or state-dir mismatch">
    If the old gateway used `--profile` or `MULLUSI_STATE_DIR` and the new one does not,
    channels will appear logged out and sessions will be empty.
    Launch the gateway with the **same** profile or state-dir you migrated, then rerun `mullusi doctor`.
  </Accordion>

  <Accordion title="Copying only mullusi.json">
    The config file alone is not enough. Model auth profiles live under
    `agents/<agentId>/agent/auth-profiles.json`, and channel/provider state still
    lives under `credentials/`. Always migrate the **entire** state directory.
  </Accordion>

  <Accordion title="Permissions and ownership">
    If you copied as root or switched users, the gateway may fail to read credentials.
    Ensure the state directory and workspace are owned by the user running the gateway.
  </Accordion>

  <Accordion title="Remote mode">
    If your UI points at a **remote** gateway, the remote host owns sessions and workspace.
    Migrate the gateway host itself, not your local laptop. See [FAQ](/help/faq#where-things-live-on-disk).
  </Accordion>

  <Accordion title="Secrets in backups">
    The state directory contains auth profiles, channel credentials, and other
    provider state.
    Store backups encrypted, avoid insecure transfer channels, and rotate keys if you suspect exposure.
  </Accordion>
</AccordionGroup>

## Verification Checklist

On the new machine, confirm:

- [ ] `mullusi status` shows the gateway running
- [ ] Channels are still connected (no re-pairing needed)
- [ ] The dashboard opens and shows existing sessions
- [ ] Workspace files (memory, configs) are present
