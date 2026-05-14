---
summary: "Find community-maintained OpenClaw plugins"
read_when:
  - You want to find third-party OpenClaw plugins
title: "Community plugins"
doc-schema-version: 1
---

Community plugins are third-party packages that extend OpenClaw with channels,
tools, providers, hooks, or other capabilities. Use [ClawHub](/clawhub) as the
primary discovery surface for public community plugins.

## Find plugins

Search ClawHub from the CLI:

```bash
openclaw plugins search "calendar"
```

Install a ClawHub plugin with an explicit source prefix:

```bash
openclaw plugins install clawhub:<package-name>
```

npm remains a supported direct-install path during the launch cutover:

```bash
openclaw plugins install npm:<package-name>
```

Use [Manage plugins](/plugins/manage-plugins) for common install, update,
inspect, and uninstall examples. Use [`openclaw plugins`](/cli/plugins) for the
full command reference and source-selection rules.

## Related

- [Plugins](/tools/plugin) - install, configure, restart, and troubleshoot
- [Manage plugins](/plugins/manage-plugins) - command examples
