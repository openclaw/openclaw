# App Review Notes

Use these steps to exercise the live OpenClaw iOS App Review Gateway.

## Demo Account / Setup

Use the OpenClaw iOS app with the live review Gateway setup code included in
the `Notes` field of this App Review submission.

The setup code is a single generated code string. It already contains the public
Gateway host and setup credential.

## Setup Walkthrough

1. Open the OpenClaw app.
2. Tap `Continue`.
3. Tap `Connect Manually` to open `Gateway Setup`.
4. In the `Setup Code` section, tap the `Enter setup code` field.
5. Paste the setup code string from the App Review submission `Notes` field.
6. Tap `Apply`.
7. If `Trust and connect` appears, tap `Trust and connect`.
8. Wait for `You're connected`.
9. Tap `Go to Chat`.

The app uses a sidebar for navigation. Open it with the sidebar button at the
top left. `Home` opens the main chat. The gear at the bottom of the sidebar opens
`Settings`; the Gateway control beside it opens connection settings.

If the app opens directly into chat instead of showing `Continue`, open the
sidebar and tap the Gateway control at the bottom. Under `Add Gateway`, paste
the supplied code into `Paste setup code` and tap `Connect`.

### Enable notifications

1. Open the sidebar and tap the `Settings` gear.
2. Open `This iPhone`.
3. Ensure the `Notifications` switch is on.
4. Tap `Back`, then open `Permissions` in the `This iPhone` section of the
   Settings list. If `Notifications` shows `Not determined`, tap its `Grant…`
   button.
5. When either step presents `Enable OpenClaw Hosted Push Relay?` or the iOS
   notification prompt, tap `Allow`.
6. Confirm the `Notifications` permission shows `Granted`.

If notifications were previously denied, use the row's `Open System Settings…`
action to change the permission in iOS Settings, then return to OpenClaw.

## Chat

1. Open the sidebar and tap `Home`.
2. Tap the message field at the bottom of the chat.
3. Send this exact message:

```text
Start Apple review checklist.
```

Expected result: the assistant replies with the available App Review demos.

## Approval Demo

1. Open the sidebar and tap `Home`.
2. Tap the message field at the bottom of the chat.
3. Send this exact message:

```text
Run the approval demo.
```

Expected result: the iPhone shows `Exec approval required` for a harmless
`printf` command that prints `OpenClaw App Review approval demo complete`.
Tap `Allow Once`, then `Dismiss` if the completed approval remains open.
The chat then confirms that the command completed. The exact confirmation
wording may vary.

## Talk

1. Open the sidebar and tap `Home`.
2. Wait for any response to finish and leave the message field empty.
3. Tap the waveform button at the right of the message field.
4. If iOS asks for microphone access, allow it. If a Speech Recognition prompt
   appears, allow that too.
5. Wait for Talk to start listening.
6. Say:

```text
I'm testing OpenClaw on an iPhone connected to a test Gateway. Summarize that in one sentence.
```

Expected result: the assistant speaks a one-sentence summary of the setup just
described, and its response appears in chat. Exact wording may vary. Tap the stop
button at the same position to stop.

## Talk + Background Audio

1. Open the sidebar, tap the `Settings` gear, and open `Talk`.
2. In the `This iPhone` section, turn on `Talk in the background` and
   `Use speakerphone`.
3. Return to `Home` and start realtime chat as described above.
4. Say:

```text
Tell me when you can hear me.
```

5. Wait for the assistant's reply. While Talk is still active, send OpenClaw to
   the background by returning to the Home Screen or locking the iPhone. Do not
   force quit the app.
6. With OpenClaw still in the background, say:

```text
Name one animal.
```

7. Listen for a spoken answer without reopening OpenClaw.

Expected result: the assistant names an animal aloud while OpenClaw remains in
the background. Reopen OpenClaw and confirm that response appears in chat and
Talk is still active, then tap the stop button.

## Gateway Status

1. Open the sidebar and choose `Overview`. If it is not listed under `Pages`,
   use `Edit Pages` beside that heading to add it.
2. In the `Gateway` card, confirm `Connection` is `Online` and `Agents` is
   at least one.
3. Open the sidebar and tap `Edit Pages` beside `Pages`. Tap the pin beside
   `Instances` if it is not already pinned, then tap `Done`.
4. Open `Instances`. This opens the Gateway's `Devices` page.
5. Confirm the review iPhone appears as a connected node.

## Live Activity / Dynamic Island

1. Start realtime chat with `Talk in the background` enabled, as described
   above.
2. Lock the iPhone while Talk is active.
3. Confirm an `OpenClaw` Live Activity appears on the Lock Screen. On iPhones
   with Dynamic Island, the activity can also appear there.
4. Reopen OpenClaw and tap the stop button.

Connection status can also appear as a Live Activity. To exercise that path,
open `Settings` → `Gateway`, tap `Reconnect`, and immediately return to the
Home Screen or lock the iPhone. Watch for `Connecting...` or `Reconnecting...`.
On a fast network this status may be brief because OpenClaw ends the connection
activity after the Gateway reconnects successfully.

## Push Notification

1. Open the sidebar and tap `Home`.
2. Tap the message field at the bottom of the chat.
3. Send this exact message:

```text
Start push notification demo.
```

4. Immediately send OpenClaw to the background and lock the iPhone. Do not
   force quit the app.

Expected result: the iPhone Lock Screen receives a visible `OpenClaw`
notification with this body:

```text
OpenClaw App Review notification demo
```

Tap the notification and unlock the iPhone if prompted. If the chat is not
already visible, open the sidebar and tap `Home`. Expected chat reply:

```text
The push notification demo completed.
```

## Push Wake / Status

1. Open the sidebar and tap `Home`.
2. Send this exact message:

```text
Start push wake demo.
```

3. Immediately send OpenClaw to the background and lock the iPhone. Do not
   force quit the app.
4. Wait for the `OpenClaw` notification on the Lock Screen. It normally appears
   about 10 seconds after the message is sent.
5. Tap the notification and unlock the iPhone if prompted. If the chat is not
   already visible, open the sidebar and tap `Home`.

Expected result: the app reconnects to the live Gateway and Chat replies:

```text
The push wake and node status demo completed.
```

## Device Permissions

OpenClaw does not present an aggregate permissions page during onboarding.
Optional access is requested when the reviewer invokes the related feature or
uses its permission control in Settings.

1. Open the sidebar, tap the `Settings` gear, and open `This iPhone`.
2. Confirm `Allow Camera` and `Keep awake` controls are available. On supported
   devices, `Health summaries` is also available.
3. Tap `Back`, then open `Permissions` in the `This iPhone` section of the
   Settings list.
4. Confirm the `System access` section includes:
   - `Notifications`
   - `Camera`
   - `Microphone`
   - `Speech Recognition`
   - `Location`
   - `Contacts`
   - `Photos`
   - `Calendars`
   - `Reminders`
5. For a permission marked `Not determined`, tap `Grant…`. Confirm the native
   iOS authorization prompt appears and make the permission choice there.
6. Confirm the `Location` section offers `Off`, `While using`, and `Always`,
   and shows the current `Precise location` status.

Previously requested permissions show their current status. Denied permissions
offer an action to open iOS Settings. Enabling camera access, Health summaries,
Always location, Voice Wake, or the hosted push relay can also present an
OpenClaw consent dialog explaining that feature's access.

### Device capability demo

Keep OpenClaw open. In `Home`, send:

```text
Start device capability demo.
```

The demo reads device status, captures a front-camera photo, and creates clearly
named `OpenClaw App Review Contact`, `OpenClaw App Review Event`, and
`OpenClaw App Review Reminder` fixtures. If it requests permission recovery, use
`Settings` → `Permissions` to grant Camera, Contacts, Calendars (Full Access),
and Reminders, then return to `Home` and send:

```text
Continue device capability demo.
```

Expected result: all ten required checks pass. Location can remain off and is
reported as an optional skip. Limited Contacts access worked in validation.

### Optional Apple Health summary

Apple Health Summaries is off by default. Under `Settings` → `This iPhone`, turn
on `Health summaries`. Read `Share Apple Health summaries with the Gateway?`
and tap `Allow` to open Apple's Health permission sheet. Choose which data to
share there. OpenClaw requests read-only access to steps, sleep, resting
heart rate, and workouts from the Apple Health app. It performs aggregation on
device and shares only a user-requested `today` summary through the user's
Gateway and configured AI provider; individual samples, sources, metadata,
clinical records, background ingestion, and writes are not supported. The
Gateway separately requires `health.summary` in
`gateway.nodes.allowCommands`.

The app does not infer read authorization from an empty result because HealthKit
intentionally makes denied data indistinguishable from unavailable data. This
feature is for personal health and fitness summaries only, not diagnosis or
medical advice.

## Share Sheet

1. Open Safari.
2. Navigate to `https://example.com`.
3. Tap the Safari toolbar `More` button.
4. Tap `Share`.
5. Tap `OpenClaw` in the row of sharing apps. Scroll along that row if it is
   not immediately visible.
6. Confirm the OpenClaw share extension appears with the shared page's URL or
   text in the editable message and a `Send to OpenClaw` button.
7. Tap `Send to OpenClaw`.

Expected result: the OpenClaw share extension sends the shared Safari page to
the live review Gateway and shows `Sent to OpenClaw.` Returning to OpenClaw
and opening `Home` shows the shared `Example Domain` page or its URL in chat.
