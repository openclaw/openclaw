# Evennia plugin development workflow

This plugin is developed from Patrick's host checkout, not from Scoob/Dumbledong containers.

## Credential boundary

- Patrick owns GitHub writes for `slimelab-ai/openclaw-evennia`.
- Dumbledong and Scoob must not receive Patrick's GitHub SSH keys, `gh` tokens, or writable remotes.
- Runtime agents may exercise the plugin through Evennia/The Dongeon using their own character credentials and the constrained OpenClaw tool surface.
- Runtime agents may report bugs, propose patches, or write notes, but Patrick applies and pushes code changes from the host checkout.

## Host source of truth

- Repo: `/home/patrick/projects/openclaw-evennia`
- Branch: `feat/evennia-channel-plugin`
- Plugin source: `extensions/evennia/`
- Live Scoob extension path: `/home/scoob/.openclaw/extensions/evennia` inside `donghouse`

## Deploy loop

1. Edit and test in the host checkout.
2. Commit/push from Patrick only.
3. Copy the built/source extension into Scoob's runtime extension directory.
4. Restart Scoob's gateway only if required by the change.
5. Smoke-test through The Dongeon.

Example deploy copy from Patrick:

```bash
cd /home/patrick/projects/openclaw-evennia
sudo lxc exec donghouse -- sudo -u scoob -H mkdir -p /home/scoob/.openclaw/extensions/evennia
sudo lxc file push -r extensions/evennia/ donghouse/home/scoob/.openclaw/extensions/
sudo lxc exec donghouse -- chown -R scoob:scoob /home/scoob/.openclaw/extensions/evennia
```

Do not clone this repo into Dumbledong or add GitHub auth there for plugin work. If a runtime agent needs to inspect behavior, give it the installed extension files or a read-only excerpt, not Patrick's writable GitHub identity.
