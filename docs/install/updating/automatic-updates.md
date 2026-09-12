---
summary: "The auto-updater, per-channel automatic behavior, and how update campaigns apply and report an update"
read_when:
  - You want unattended updates on a managed Gateway service
  - You need to know when an automatic update applies and how to postpone it
  - You are turning update checks or automatic updates off
title: "Automatic updates"
---

Enabling the auto-updater, what each channel does automatically, and how update campaigns run. Part of the [Updating](/install/updating) guide.

## Auto-updater

Off by default. Enable it in `~/.openclaw/openclaw.json`:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
    },
  },
}
```

You can also choose the update channel and enable automatic updates from
**Settings → Updates** (`/settings/updates`) in the Control UI.
**Check for updates** controls the existing `update.checkOnStart` setting.
When it is off, **Automatic updates** is disabled but keeps your saved preference;
turning checks back on resumes discovery and any enabled automatic-update policy.
This does not change your separate feature-statistics preference.
Recorded failures on that page include typed **Check status** and **Retry
update** actions when the connected Gateway supports them. See [Update
troubleshooting](/install/update-troubleshooting) for reason codes, guided
recovery, CLI fallbacks, and diagnostics to collect.
For a `dev` git install, opening this page refreshes the tracked upstream and
shows whether the checkout is current, ahead, diverged, unavailable, or a
specific number of commits behind. It also shows exact and relative build,
verified install, and last-commit times. Existing checkouts show an unknown
install time until their next verified successful update.

Automatic installation requires a managed Gateway service that can hand off
the update and restart safely. A Gateway running directly in a terminal can
still show update hints, but it does not automatically replace its running
installation. Stop that Gateway, run `openclaw update`, and launch it again
afterward, or [install a managed service](/cli/gateway#manage-the-gateway-service) for
unattended updates.

| Channel           | Behavior                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable`          | After a built-in delay with deterministic jitter for a spread rollout, announces an update campaign.                                                                |
| `extended-stable` | Checks for a read-only update hint on startup and every 24 hours when `checkOnStart` is enabled. Never applies automatically.                                       |
| `beta`            | Checks on a built-in interval and announces an update campaign as soon as a newer release is available.                                                             |
| `dev`             | With `auto.enabled`, git installs check hourly. When upstream commits are available, the Gateway announces an update campaign pinned to the exact announced commit. |

### Update campaigns

When an automatic update is due, the campaign waits for active work to finish,
then starts a one-minute countdown. Once that countdown starts, new work does
not reset it or return the campaign to waiting. A 15-minute hard deadline starts
the update even if work remains, using the normal restart drain and
session-recovery path. Open terminal sessions do not defer the countdown or
apply. The Gateway restart ends these process-local PTYs, and terminal sessions
are not recovered afterward.

An admin can use **Hold 1 h** once to postpone the campaign and shift its hard
deadline, or choose **Update now** from the sidebar update card or
**Settings → Updates**. For a `dev` git install, the campaign installs the exact
commit it announced. The displayed list previews up to five commits from that
fixed target and does not move if upstream `main` advances during the countdown.

Every failed apply ends the campaign so the UI does not remain on
**Updating…**. Failures after a managed-service handoff starts are also recorded
in the restart sentinel and surface after the Gateway returns.

`update.checkOnStart: false` disables all automatic update checks, feature
statistics, and update notices, even when `update.auto.enabled` is `true`.
`OPENCLAW_NO_AUTO_UPDATE=1` also disables automatic checks and applies.
External-supervisor mode disables automatic applies; startup update hints can
still run unless `update.checkOnStart` is also disabled. See
[Usage telemetry and update checks](/gateway/telemetry) for the information
sent by the daily check and optional anonymous feature statistics.

Disabling checks also cancels unfinished discovery and its campaign; a late
response from the previous settings cannot start an update afterward.

Gateway shutdown or replacement cancels unfinished update discovery and waits
for its Git processes and temporary preflight cleanup to settle. Updates already
handed off to the managed service updater remain under that separate updater’s
control.

The gateway also logs an update hint on startup (disable with
`update.checkOnStart: false`). Stored extended-stable selections use this
read-only hint path and the existing 24-hour hint interval, but never invoke
automatic installation, handoff, restart, stable delay/jitter, or beta polling.

Package-manager updates requested through the live Gateway control-plane
(`update.run`) do not replace the package tree inside the running Gateway
process. On managed service installs, the Gateway starts a detached handoff
that runs the normal `openclaw update --yes --json` CLI path. The old Gateway
keeps serving through candidate validation; the helper parks it only for
activation. The CLI swaps the package, applies required migrations, refreshes
service metadata, starts and verifies the Gateway, and recovers an
installed-but-unloaded macOS LaunchAgent when possible. If the Gateway cannot
make that handoff safely,
`update.run` reports a safe shell command instead of running the package
manager in-process.

When `update.run` has a routable chat session, the Gateway sends an update
acknowledgement before starting the handoff or in-process update. It waits up to
10 seconds for delivery; a failed chat send does not block the update. The RPC
response includes `ackDelivered` so clients can distinguish a delivered
acknowledgement from an unavailable or failed route. Restart, verification,
and completion notices follow the durable run state, as described in
[From chat](/install/updating#from-chat).

The Control UI includes its active session in the update request. Any run with an
existing internal/webchat origin session receives its report in that session's
transcript, whether or not the caller supplied a delivery context. Sessions with
an external delivery route receive a durable notice in that channel. Updates
without an originating session send their notice through the system main
session's external route when available. Otherwise, recovery keeps the
system-session wake without an outbound chat notice. Session-less recovery never
resumes a supplied continuation as another chat's turn.

The Control UI sidebar update card shows **Update Gateway** when it will start
this `update.run` flow directly. This covers browser-hosted Control UI, remote
Gateways, and manually managed local Gateways.

Manual updates started from the Control UI always ask first. The first click on
the sidebar update card or on **Settings → Updates → Update now** opens a
confirmation naming the target, the installed and available versions when known,
and the restart impact; it sends nothing until you choose **Update and restart**.
Cancel, Escape, and dismissing the dialog leave the Gateway untouched. Automatic
campaigns, the CLI, and `update.run` API clients are unaffected.

After confirmation, the dialog shows the live phase list, step details, and
verification results. It stays open during restart and resumes from the Gateway's
run record after reconnecting. Success and failure both leave a final report in
the dialog and **Settings → Updates**. See [Control UI updates](/web/control-ui/settings#updates).

In the signed macOS app, a local app-owned Gateway changes that card to
**Update Mac app + Gateway**. Sparkle updates the app first; after relaunch, the
app runs `openclaw update --tag <app-version> --json`, restarts its Gateway,
and verifies health in a setup-style progress window. The window appears only
when that managed Gateway needs update, repair, or installation; app-only updates relaunch
directly into the app. Failure details stay visible with Retry, [Update guide](/install/updating), and
[Discord](https://discord.gg/clawd) actions. The app never uses this coordinated
path for a remote or externally managed Gateway, never downgrades a newer
Gateway, and never overrides an `extended-stable` channel pin.

When the update succeeds, the app queues a one-time welcome event for the most
recent top-level direct session with a real user/channel interaction. Cron runs,
heartbeats, and background-only session updates do not move that selection. In
remote mode, the app updates only its local Mac node runtime and sends the event
only when the connected remote Gateway is at least as new as the app.
