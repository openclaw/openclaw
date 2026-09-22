---
summary: "Talk controls and behavior in the macOS, Apple Watch, and Android clients"
read_when:
  - Using Talk from the macOS menu bar or overlay
  - Setting up standalone voice on Apple Watch
  - Using dictation, voice notes, or Talk on Android
title: "Talk client UI"
sidebarTitle: "Client UI"
---

## macOS UI

- Menu bar: **Voice & Talk Settings…** opens the native **Voice & Talk** settings page.
- Native settings: **Use realtime Gateway relay** is a local, default-off opt-in for this Mac.
- **Open in Dashboard** hands provider, model, voice, and transport setup to Control UI **Settings → Talk** under **Connections**.
- Menu bar: **Talk Mode** starts or stops the current Talk session.
- Overlay: the orb renders the universal talk waveform (shared with iOS, watchOS, and Android). Listening follows the live mic level, Speaking follows the actual TTS playback envelope, Thinking breathes softly. Click the orb to pause/resume, double-click to stop speaking, click X to exit Talk mode.

## Apple Watch UI

Tap **Connect Apple Watch** in iPhone **Settings → Apple Watch**, then open
**Talk on Watch** and tap **Start**. Voice is included without a separate enable
setting; setup alone does not activate the microphone. The Watch asks you to choose an agent when
more than one is available, creates a separate chat for the call, and shows
the latest speech transcripts with **Mute** and **End** controls. It does not run
the agent or stock Codex runtime locally.

Keep the app in the foreground until connected. Established calls use
background audio; an unfinished startup stops if backgrounded. Physical
wrist-down, speaker routing, cellular handoff, and long-call endurance remain
unverified. Simulator results and macOS provider-audio probes are not proof of
Watch background behavior. See [Watch setup and limits](/platforms/ios#standalone-voice).

## Android UI

- Android's main navigation is **Home**, **Chat**, and **Settings**. Voice input
  lives in the Chat composer rather than a separate Voice tab.
- Tap the composer microphone for on-device dictation. Long-press it to record
  a voice-note attachment. Start continuous Talk from the Talk waveform.
- Dictation, voice-note recording, and Talk are mutually exclusive microphone
  paths; starting one stops or blocks the others.
- Realtime Talk prefers a connected Bluetooth Classic or BLE headset
  microphone; if it disconnects, the app requests another headset input or
  falls back to the default microphone, restoring the default preference once
  capture stops.
- Realtime Talk requests Android communication mode and audio focus, using a
  connected external output or the built-in speaker. Microphone audio is sent
  during playback only while acoustic echo cancellation is enabled and the
  communication mode and focus remain active. Without echo cancellation,
  microphone audio is not sent during playback. Android presentation timestamps
  estimate playback completion when available. Routes without usable timestamps use
  approximate playback position plus the nominal PCM duration; this cannot
  guarantee that all acoustic output has drained on every device.
- Losing audio focus or encountering a playback-device failure ends realtime
  Talk with an error. Interruption clears queued output before capture resumes;
  stopped sessions cannot acknowledge playback through a replacement Gateway.
- Realtime **Thinking** follows provider response generation or an accepted
  OpenClaw consult, not input transcription, which may finish after the answer.
  Direct replies without a provider or Gateway response-start signal stay
  **Listening** until output arrives. Empty completed responses return to **Listening**;
  buffered audio stays **Speaking** until playback drains.
- Dictation and voice-note recording stop when the app leaves the foreground or
  the user leaves Chat.
- Talk Mode keeps running until toggled off or the node disconnects, using Android's microphone foreground-service type while active.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency `AudioTrack` streaming.
