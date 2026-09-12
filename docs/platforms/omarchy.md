---
summary: "OpenClaw on Omarchy: bar plugin, desktop app handoff, and support"
read_when:
  - Installing the OpenClaw bar plugin on Omarchy
  - Using agents, sessions, and quick prompts from the Omarchy bar
  - Troubleshooting duplicate OpenClaw icons or desktop connection handoff
title: "Omarchy"
---

# OpenClaw on Omarchy

The OpenClaw Omarchy plugin puts agents, recent sessions, and a quick prompt in
your desktop bar. Its monochrome mascot follows the shell theme, blinks, and
animates with reported agent activity. With the Linux desktop app running, the
plugin becomes the single bar entry and uses the app's selected Gateway.

This page covers the plugin in the OpenClaw source tree. Install it separately;
do not assume an older desktop release includes the matching integration.
For Gateway installation and the desktop app itself, see [Linux](/platforms/linux).

## Requirements

- Omarchy 4 with its Quickshell bar and plugin support. Earlier Waybar-based
  Omarchy versions do not provide this plugin host.
- Python 3 and PyGObject for the desktop session's D-Bus connection.
- Either a connected OpenClaw Linux desktop app with Omarchy integration, or
  an `openclaw` CLI with a configured, reachable Gateway and support for
  `openclaw gateway call --expect-url`. Use a CLI build containing this
  integration; older builds may not support that option.

The desktop app is optional. The plugin resolves the CLI from
`OPENCLAW_DESKTOP_CLI`, then `~/.openclaw/bin/openclaw`, then the graphical
session's `PATH`. It does not install or start a Gateway in the background.
Use your existing OpenClaw installation and authentication. In standalone
mode, the plugin identifies the selected Gateway through
`openclaw status --json` and checks that destination before each request. If status redacts the
endpoint URL, standalone mode cannot establish the destination and disables
requests. Use the desktop app for that connection.

## Install the bar plugin

From an OpenClaw source checkout containing `apps/linux/omarchy`, run:

```bash
bash apps/linux/omarchy/install.sh
```

The installer places the plugin in your user configuration. Check it with:

```bash
omarchy plugin validate ~/.config/omarchy/plugins/openclaw.desktop
omarchy plugin enable openclaw.desktop
```

Click the OpenClaw mascot. Confirm that the panel shows the expected agents
and sessions before sending a prompt. When using the desktop app, connect it
to your intended Gateway first.

## Use agents, sessions, and quick prompts

Select an agent, search sessions, or use the **All**, **Active**, and
**Attention** filters. Session cards show recent messages or activity,
status, and available model and token details. Search and counts cover the
loaded sessions; open the dashboard for full history.

Click a session to target it, then use **Open session** to continue in the
desktop app. Without the app, the plugin opens the session in the TUI.
Choose **New session** to start a separate conversation with the selected agent.

- **Ctrl+L** focuses **Quick prompt**.
- **Ctrl+Enter** sends. **Enter** inserts a newline.
- **Esc** closes the panel.
- Middle-click the mascot to refresh.

The prompt limit is 8,000 characters. An accepted send means the Gateway
accepted the work; watch the session for the result. If a send's outcome is
unknown, check the session before sending again. The plugin does not retry
uncertain sends automatically. Drafts live in memory and do not survive a
shell restart.

**Hide previews** hides session titles, activity, and message previews. Agent
names, models, and channels remain visible. The attention badge summarizes
reported session activity; it is not an approval inbox. Open the dashboard to
review approvals.

## One icon with the desktop app

| Running                         | Bar behavior                                                             |
| ------------------------------- | ------------------------------------------------------------------------ |
| Plugin only                     | The plugin shows sessions through the configured CLI.                    |
| Desktop app only                | The desktop app shows its normal tray icon.                              |
| Both, with matching integration | The plugin stays visible and the app hides its duplicate tray icon.      |
| Older app without integration   | The plugin yields when it recognizes the app's session-bus registration. |

While both are connected, session actions and quick prompts use the desktop
app's selected Gateway, including remote connections. Opening a session focuses
the existing app. If that app disconnects, the plugin shows the connection
problem and disables sending instead of switching to a different CLI Gateway.

If the Gateway changes, the plugin clears the previous session selection and
keeps your draft. Choose **Use this Gateway** to confirm the new destination
before sending. A prompt already submitted stays bound to its original route.

Disable the plugin to restore the app's tray icon:

```bash
omarchy plugin disable openclaw.desktop
```

The app also restores its icon after the plugin stops responding. This may
take a short interval while it detects that the plugin is gone.

## Updates

Update each component through the installation that owns it: the Omarchy
updater for the shell, the desktop app's supported update flow for the app,
and your existing OpenClaw updater for the CLI and Gateway. After updating
the source checkout, rerun the plugin installer to update its installed copy.
See [Updating](/install/updating) for Gateway update guidance.

## Troubleshooting and support

| Symptom                                    | Check                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No plugin icon                             | Validate and enable the plugin using the commands above. An older running desktop app may own the visible icon.                                      |
| Two OpenClaw icons                         | Update both the plugin and desktop app to versions with the integration. They must run in the same desktop user session.                             |
| CLI not found                              | Check `OPENCLAW_DESKTOP_CLI`, `~/.openclaw/bin/openclaw`, or the graphical session's `PATH`. Install through your normal OpenClaw installation path. |
| Desktop connection unavailable             | Open the desktop app and reconnect to its selected Gateway. Resolve authentication or pairing there.                                                 |
| Sessions look stale or sending is disabled | Refresh the panel and check the connection error. The plugin retains cached results after a failed refresh.                                          |
| A prompt may have been sent                | Open the target session and inspect its latest messages before resubmitting.                                                                         |

The integration targets Omarchy 4's Quickshell environment. Other bars, older
Omarchy releases, and other desktop sessions require their own integration;
a passing mock-Gateway test does not establish compatibility with those hosts.
The plugin samples Gateway activity rather than streaming every event.
Desktop app limitations, including Wayland global shortcuts, are documented
in the [Linux guide](/platforms/linux#quick-chat).

For setup help, use [OpenClaw support](/help). For a reproducible plugin or
handoff defect, file an [OpenClaw bug report](https://github.com/openclaw/openclaw/issues/new?template=bug_report.yml)
with Omarchy, plugin/source, desktop app, and Gateway versions; whether the
Gateway is local or remote; and the steps to reproduce. Remove credentials
and private session content from logs or screenshots before sharing them.
