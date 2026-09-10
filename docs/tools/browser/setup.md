---
summary: "Quick start commands, plugin enablement, agent tool policy, and the missing-command fix"
title: "Browser setup"
read_when:
  - You are starting the OpenClaw browser for the first time
  - The agent reports the browser tool as unavailable
  - The `openclaw browser` command is missing after an upgrade
---

## Quick start

```bash
openclaw browser --browser-profile openclaw doctor
openclaw browser --browser-profile openclaw doctor --deep
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

"Browser disabled" means the plugin or `browser.enabled` is off; see
[Configuration](/tools/browser/configuration#configuration) and [Plugin control](#plugin-control).

If `openclaw browser` is missing entirely, or the agent says the browser tool
is unavailable, jump to [Missing browser command or tool](#missing-browser-command-or-tool).

## Plugin control

The default `browser` tool is a bundled plugin. Disable it to replace it with another plugin that registers the same `browser` tool name:

```json5
{
  plugins: {
    entries: {
      browser: {
        enabled: false,
      },
    },
  },
}
```

Defaults need both `plugins.entries.browser.enabled` **and** `browser.enabled=true`. Disabling only the plugin removes the `openclaw browser` CLI, `browser.request` gateway method, agent tool, and control service as one unit; your `browser.*` config stays intact for a replacement.

Profiles, launch settings, snapshot defaults, tab cleanup, and
`browser.allowSystemProfileImport` hot-reload. Import permission changes apply to
new imports; an import already in progress keeps its admission. Browser
enablement, evaluation, SSRF policy, and extension relay settings require a Gateway
restart. See [Config hot reload](/gateway/configuration#config-hot-reload).

## Agent guidance

Tool-profile note: `tools.profile: "coding"` includes `web_search` and
`web_fetch`, but not the full `browser` tool. To let the agent or a
spawned sub-agent use browser automation, add browser at the profile
stage:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["browser"],
  },
}
```

For a single agent, use `agents.entries.*.tools.alsoAllow: ["browser"]`.
`tools.subagents.tools.allow: ["browser"]` alone is not enough because sub-agent
policy is applied after profile filtering.

The browser plugin ships two levels of agent guidance:

- The `browser` tool description carries the compact always-on contract: pick
  the right profile, keep refs on the same tab, use `tabId`/labels for tab
  targeting, and load the browser skill for multi-step work.
- The bundled `browser-automation` skill carries the longer operating loop:
  check status/tabs first, label task tabs, snapshot before acting, resnapshot
  after UI changes, recover stale refs once, and report login/2FA/captcha or
  camera/microphone blockers as manual action instead of guessing.

Plugin-bundled skills are listed in the agent's available skills when the
plugin is enabled. The full skill instructions load on demand, so routine
turns do not pay the full token cost.

For page text, use a selector-scoped snapshot or `act:evaluate` that returns
only the relevant text or structured data, then let the active agent model
reason over that bounded result. Use efficient snapshots for controls and
action discovery; they intentionally omit most non-interactive prose.

## Missing browser command or tool

If `openclaw browser` is unknown after an upgrade, `browser.request` is missing, or the agent reports the browser tool as unavailable, the usual cause is a `plugins.allow` list that omits `browser` and no root `browser` config block exists. Add it:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

An explicit root `browser` block (any key under `browser`, such as
`browser.enabled=true` or `browser.profiles.<name>`) activates the bundled
browser plugin even under a restrictive `plugins.allow`, matching bundled
channel config behavior. `plugins.entries.browser.enabled=true` and
`tools.alsoAllow: ["browser"]` do not substitute for allowlist membership by
themselves. Removing `plugins.allow` entirely also restores the default.
