---
summary: "Find community-maintained OpenClaw plugins and understand when to submit docs changes"
read_when:
  - You want to find third-party OpenClaw plugins
  - You want to publish or list your own plugin
  - You want to know when a docs PR is appropriate for a community plugin
title: "Community plugins"
doc-schema-version: 1
---

Community plugins are third-party packages that extend OpenClaw with channels,
tools, providers, hooks, or other capabilities. Use [ClawHub](/clawhub) as the
primary discovery surface for public community plugins.

Do not open a docs-only PR just to add your plugin here for discoverability.
Publish it on ClawHub instead so users can see current metadata, releases,
scan status, and install hints in one place.

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

## Publish your plugin

Publish public plugins to ClawHub when you want OpenClaw users to discover and
install them. ClawHub owns the live package listing, release history, and scan
state; this docs page does not maintain a static third-party package catalog.

Use these references:

- [Building plugins](/plugins/building-plugins) for the native plugin package
  shape and first publish workflow.
- [ClawHub publishing](/clawhub/publishing) for owner scope, release review,
  package validation, and transfer rules.
- [Plugin manifest](/plugins/manifest) for native `openclaw.plugin.json`
  requirements.

## Open a docs PR only for source-doc changes

Open a docs PR when the OpenClaw docs themselves need to change. Good examples:

- correcting install or configuration guidance in an OpenClaw-owned page
- adding cross-repo documentation that belongs in the main docs set
- updating a bundled or official external plugin guide after behavior changes
- improving a troubleshooting page with a reproduced OpenClaw failure mode

Do not open a docs PR only to list a new third-party plugin. Static catalogs
drift quickly and are not treated as canonical OpenClaw-owned metadata.

## Submission quality bar

Community plugins should be useful, documented, and safe to operate before you
publish them or ask the docs to reference them.

| Requirement                 | Why                                           |
| --------------------------- | --------------------------------------------- |
| Published on ClawHub or npm | Users need `openclaw plugins install` to work |
| Public source repo          | Source review, issue tracking, transparency   |
| Setup and usage docs        | Users need to know how to configure it        |
| Clear maintenance owner     | Users need a place to report issues           |
| Safe install behavior       | Registry and local scans should not block use |

Low-effort wrappers, unclear ownership, missing setup docs, or unmaintained
packages are poor candidates for OpenClaw docs links.

## Related

- [Plugins](/tools/plugin) - install, configure, restart, and troubleshoot
- [Manage plugins](/plugins/manage-plugins) - command examples
- [Building plugins](/plugins/building-plugins) - create your own plugin
- [Plugin manifest](/plugins/manifest) - manifest schema
- [ClawHub publishing](/clawhub/publishing) - publish and release rules
