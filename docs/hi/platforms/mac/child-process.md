---
summary: "macOS पर Gateway जीवनचक्र (launchd)"
read_when:
  - Gateway जीवनचक्र के साथ mac ऐप का एकीकरण
title: "Gateway जीवनचक्र"
---

# macOS पर Gateway जीवनचक्र

macOS ऐप डिफ़ॉल्ट रूप से **launchd के ज़रिए Gateway को manage करता है** और Gateway को child process के रूप में spawn नहीं करता। It first tries to attach to an already‑running
Gateway on the configured port; if none is reachable, it enables the launchd
service via the external `openclaw` CLI (no embedded runtime). This gives you
reliable auto‑start at login and restart on crashes.

Child‑process mode (Gateway spawned directly by the app) is **not in use** today.
If you need tighter coupling to the UI, run the Gateway manually in a terminal.

## डिफ़ॉल्ट व्यवहार (launchd)

- The app installs a per‑user LaunchAgent labeled `bot.molt.gateway`
  (or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` is supported).
- जब Local मोड सक्षम होता है, ऐप सुनिश्चित करता है कि LaunchAgent लोड हो और
  आवश्यकता होने पर Gateway शुरू करता है।
- लॉग्स launchd Gateway लॉग पथ पर लिखे जाते हैं (Debug Settings में दिखाई देते हैं)।

सामान्य कमांड:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Replace the label with `bot.molt.<profile>` when running a named profile.

## Unsigned dev builds

`scripts/restart-mac.sh --no-sign` is for fast local builds when you don’t have
signing keys. To prevent launchd from pointing at an unsigned relay binary, it:

- `~/.openclaw/disable-launchagent` लिखता है।

Signed runs of `scripts/restart-mac.sh` clear this override if the marker is
present. To reset manually:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only मोड

To force the macOS app to **never install or manage launchd**, launch it with
`--attach-only` (or `--no-launchd`). This sets `~/.openclaw/disable-launchagent`,
so the app only attaches to an already running Gateway. You can toggle the same
behavior in Debug Settings.

## Remote मोड

Remote mode never starts a local Gateway. The app uses an SSH tunnel to the
remote host and connects over that tunnel.

## हम launchd को क्यों प्राथमिकता देते हैं

- लॉगिन पर ऑटो‑स्टार्ट।
- बिल्ट‑इन रीस्टार्ट/KeepAlive सेमांटिक्स।
- पूर्वानुमेय लॉग्स और सुपरविजन।

यदि भविष्य में फिर से किसी वास्तविक child‑process मोड की आवश्यकता होती है, तो
इसे एक अलग, स्पष्ट केवल‑डेव मोड के रूप में प्रलेखित किया जाना चाहिए।
