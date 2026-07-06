# OpenClaw Android Changelog

## Unreleased

Assistant messages now offer a long-press Listen action with gateway TTS playback, on-device fallback, and tap-to-stop status.

The Settings About screen now shows the animated mascot with the app tagline plus Website, Docs, GitHub, and Discord links.

Adds a read-only Files browser for agent workspaces with directory navigation, text and image previews, and system share export.

Android onboarding now completes after permission-triggered node approval and keeps Back navigation from cycling between permissions and approval.

Third-party Android builds can now opt into Always location through Android settings, with requested background checks disclosed in the persistent node notification while Play builds remain foreground-only. (#68581) Thanks @ioridev.

Android SMS permission guidance now explains the separate Gateway `allowCommands` opt-in required for SMS search and sending. (#91781) Thanks @narcissus0702.

Android system notifications now open OpenClaw when tapped without accepting arbitrary external deeplinks.

Android chat history now excludes internal, reasoning, and tool-result rows from rendered messages and the offline transcript cache.

Android chat messages now expose long-press actions for whole-message copy, selective text copy, sharing, and quoted replies.

The OpenClaw mascot now comes alive across onboarding and the app headers with the same float, blink, antenna-wiggle, and claw-snap animation as openclaw.ai.

Adds read-only Cron Job details in Settings, including schedule, payload and delivery state, job ID copy, refresh, and nested back navigation.

Gateway sessions now retry immediately when Android regains a validated network, without waiting for the current reconnect backoff.

Canvas main-frame navigation now blocks device-local loopback and unspecified web targets while preserving remote, LAN, emulator-host, and bundled canvases.

Voice settings now stay within their intended width instead of overflowing or clipping on constrained screens.

Camera clip capture no longer emits release-path diagnostics containing temporary file details.

Push-to-talk now waits for realtime input and output to stop, keeps finishing turns serialized, and safely resumes the matching relay capture.

## 2026.6.11 - 2026-07-01

Improves Android gateway setup with localized onboarding, QR pairing fixes, and support for local mDNS gateway hosts.

Adds clearer recovery guidance for TLS fingerprint timeouts, mobile protocol mismatches, and gateway auth states.

Refreshes native Android localization coverage, including Swedish app naming and localized gateway trust flows.

## 2026.6.2 - 2026-06-02

OpenClaw is now available on Android.

Connect to your OpenClaw Gateway to chat with your assistant, use realtime Talk mode, review approvals, and bring Android device capabilities like camera, location, screen, and notifications into your private automation workflows.
