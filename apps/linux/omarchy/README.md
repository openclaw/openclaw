# OpenClaw for the Omarchy bar

This optional Omarchy 4 plugin shows OpenClaw agents, recent and active sessions,
attention indicators, and a quick prompt. Its animated mascot uses the bar’s
foreground color, so it follows your theme without adding colors.

## Install

From this directory in an OpenClaw checkout:

```bash
./install.sh
```

The installer requires an existing Omarchy installation, Python 3, and the
Python GObject bindings (`python-gobject` on Arch Linux). It validates the plugin
against the installed Omarchy manifest schema before writing files. It copies
this plugin to `${XDG_CONFIG_HOME:-~/.config}/omarchy/plugins/openclaw.desktop`
and enables it through Omarchy. It installs no dependencies and does not start,
restart, or reconfigure a Gateway. Run it again to update the installed files;
existing placement is preserved. Before replacing plugin files or enabling the
plugin, it backs up the affected existing files under Omarchy’s `backups`
directory and prints the location.

Other user plugins, including earlier private OpenClaw widgets, are left alone.
If you previously installed one, disable its separate bar entry yourself to
avoid showing both widgets.

To disable this plugin:

```bash
omarchy plugin disable openclaw.desktop
```

## Use

Click the mascot to see agents and sessions. Filter by agent, active work, or
attention; search by session title, agent, or model. Select a session to continue
it, or choose **New session**. When your Gateway requires agent selection, pick
an agent before sending. **Hide previews** conceals session titles and messages.

Use **Ctrl+L** to focus the prompt and **Ctrl+Enter** to send. **Open session**
opens the selected conversation. A prompt is cleared only after confirmed
acceptance. If acceptance is unknown, inspect the destination before explicitly
allowing another send; the widget never retries prompts automatically.

With a matching Linux desktop app running, the widget uses that app’s selected
Gateway and exposes **Quick Chat**, **Dashboard**, **Updates**, and **Quit app**.
The desktop app and widget coordinate their icons so there is one entry point.
An older desktop app retains its tray icon and the widget hides until it exits.
Without the app, the widget uses the installed OpenClaw CLI and its Gateway.

When the Gateway route changes, the widget clears the old session selection,
keeps your draft, and asks you to choose **Use this Gateway** before sending if
a draft or pending prompt belongs to the previous route. With no draft or pending
prompt, it switches automatically.
Prompts remain bound to the route shown when they were submitted.

## Connection and lifecycle

`Service.qml` owns one Python worker shared across monitors. Bar instances
register with that service through Omarchy’s `bar.shell.serviceFor` API. The
worker remains alive while any instance is registered, including while yielding
to an older desktop app. Removing the final instance closes its input so the
worker can release its desktop claim and exit.

The worker exchanges JSON lines over standard input and output. It uses public
Gateway methods for agents, session projections, and prompt acceptance; the QML
layer does not read Gateway credentials or session storage. Refreshes run every
10 seconds while a popup is open and every minute otherwise. Desktop presence
and claim renewal are handled independently by the worker.

Disconnected data is marked as cached and sending is disabled. Use **Refresh**
to check again, the desktop app’s connection status when using the app, or
**Diagnostics** when using the standalone CLI. Agent and session counts describe
the bounded recent/active projection; open the dashboard for full history.
