---
summary: "Record speech in the Control UI and insert a transcript into the chat composer"
read_when:
  - You want to dictate a chat message
  - You need to configure speech-to-text for the Control UI
  - You need the dictation privacy and architecture notes
title: "Control UI Dictation"
sidebarTitle: "Dictation"
---

Dictation records one short voice clip, transcribes it through OpenClaw's existing audio media pipeline, and inserts the result into the chat composer. It does not send the chat message automatically, so you can review and edit the transcript first.

## Use dictation

1. Put the caret where the transcript should be inserted.
2. Click **Dictate**, or press and hold `Ctrl+M` while the composer is focused.
3. Speak while the waveform and elapsed timer are visible.
4. Release `Ctrl+M` or choose **Finish and transcribe**. Choose **Cancel** or press `Escape` to discard the clip.
5. Review the text inserted at the captured selection, edit it if needed, and send normally.

The first recording asks for microphone permission. OpenClaw uses the operating system's default input device. Change that device in macOS, Windows, or Linux sound settings.

### UI states

| State                 | Visible behavior                                         | Available action                               |
| --------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| Idle                  | Microphone control in the composer toolbar               | Click or hold `Ctrl+M`                         |
| Requesting permission | Permission status and cancel control                     | Approve in the browser/OS, or cancel           |
| Recording             | Live waveform, `m:ss` timer, cancel and confirm controls | Release `Ctrl+M`, confirm, `Escape`, or cancel |
| Transcribing          | Progress indicator; composer send controls are hidden    | Wait for batch STT                             |
| Complete              | Transcript inserted into the existing draft              | Edit or send                                   |
| Error                 | An actionable inline alert                               | Dismiss, correct the issue, and retry          |

Buttons expose accessible names, the shortcut is declared with `aria-keyshortcuts`, and state/error updates use polite status or alert announcements. Waveform and progress animation stop when reduced motion is enabled.

## Configure speech-to-text

Dictation uses `tools.media.audio`; there is no separate provider, credential, or retention setting. Configure a supported provider or a local Whisper CLI exactly as you would for inbound voice notes. For example:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

See [Audio and voice notes](/nodes/audio) for provider, model, local CLI, timeout, and language guidance. Provider credentials remain on the Gateway; the browser only calls the authenticated `audio.transcribe` Gateway method.

## Permissions and recovery

- **Permission denied:** enable microphone access for the Control UI origin in browser and operating system privacy settings, then retry.
- **No input device:** connect or enable a microphone and select it as the OS default.
- **Device busy:** close another app holding exclusive microphone access.
- **No speech detected:** record again closer to the microphone and avoid a very short or silent clip.
- **Provider unavailable:** verify `tools.media.audio` and provider credentials, or configure a local CLI fallback.
- **Disconnected Gateway:** reconnect before starting transcription. An unsent typed draft is preserved through all failures.

Microphone capture requires a secure browser context. Loopback URLs such as `http://127.0.0.1` are treated as trustworthy by modern browsers; remote deployments should use HTTPS. Current Chromium-based browsers on macOS, Windows, and Linux provide the required `getUserMedia` and `MediaRecorder` interfaces. Available recording containers vary by browser, so the client negotiates WebM/Opus, Ogg/Opus, or MP4 in that order.

## Privacy controls

- The browser keeps the recording in memory and does not add it to chat history, attachments, local storage, or a retry queue.
- Recording stops after two minutes. The Gateway rejects payloads larger than 12 MB and unsupported audio MIME types.
- The authenticated Gateway writes a `0600` temporary file only because local CLI transcribers require a path. It removes the private temporary directory after every success or failure.
- A configured cloud STT provider receives the clip under that provider's data handling terms. Choose a local CLI model in `tools.media.audio.models` when audio must not leave the Gateway host.
- Only the resulting text enters the composer. It reaches the session transcript only if you send the message.

## Observable reference behavior

The interaction model was independently designed from public behavior, without using Cursor code or assets. Cursor's public 3.1 changelog says its upgraded voice input records a complete clip, uses batch STT, supports press-and-hold `Ctrl+M`, and shows a waveform, timer, cancel, and confirm controls. Its public demo shows those controls replacing the normal composer content during recording. Cursor support also states that voice input uses the OS default microphone and that speech-to-text populates the normal chat input.

OpenClaw keeps those useful workflow properties while using its own Lit components, design tokens, Gateway protocol, provider registry, and media-understanding implementation. Cursor's internal timing, network protocol, retention behavior, accessibility tree, and error implementation were not observable and were not inferred.

Public references, observed June 29, 2026:

- [Cursor 3.1 changelog](https://cursor.com/changelog/3-1)
- [Cursor microphone input support answer](https://forum.cursor.com/t/microphone-input-selection/148341)
- [Cursor voice input billing and composer behavior](https://forum.cursor.com/t/cursor-voice-input/152878)

## Architecture decision record

**Decision:** capture one bounded clip in the browser and submit it to a new authenticated `audio.transcribe` Gateway method, which delegates to the existing `tools.media.audio` batch pipeline.

**Why:** batch STT produces a stable editable result, existing provider and local-CLI configuration stays canonical, credentials never enter the browser, and one cleanup owner can enforce size, MIME, temporary-file, and deletion policy.

**Alternatives rejected:** browser Web Speech has inconsistent browser/vendor behavior and unclear provider control; a second dictation-specific provider configuration would duplicate credentials and fallback policy; realtime Talk is conversational and can invoke an agent, while dictation must only produce editable text.

**Consequences:** transcription begins after confirmation rather than streaming words live. Path-based local CLI support requires a short-lived private file on the Gateway. The protocol addition is additive and requires `operator.write` scope.
