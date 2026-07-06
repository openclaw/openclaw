# OpenClaw Android Changelog

## Unreleased

The OpenClaw mascot now comes alive across onboarding and the app headers with the same float, blink, antenna-wiggle, and claw-snap animation as openclaw.ai.

Adds read-only Cron Job details in Settings, including schedule, payload and delivery state, job ID copy, refresh, and nested back navigation.

Gateway sessions now retry immediately when Android regains a validated network, without waiting for the current reconnect backoff.

Canvas main-frame navigation now blocks device-local loopback and unspecified web targets while preserving remote, LAN, emulator-host, and bundled canvases.

Voice settings now stay within their intended width instead of overflowing or clipping on constrained screens.

Camera clip capture no longer emits release-path diagnostics containing temporary file details.

## 2026.6.11 - 2026-07-01

Improves Android gateway setup with localized onboarding, QR pairing fixes, and support for local mDNS gateway hosts.

Adds clearer recovery guidance for TLS fingerprint timeouts, mobile protocol mismatches, and gateway auth states.

Refreshes native Android localization coverage, including Swedish app naming and localized gateway trust flows.

## 2026.6.2 - 2026-06-02

OpenClaw is now available on Android.

Connect to your OpenClaw Gateway to chat with your assistant, use realtime Talk mode, review approvals, and bring Android device capabilities like camera, location, screen, and notifications into your private automation workflows.
