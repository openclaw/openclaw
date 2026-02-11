# Changelog

## 2026.2.19

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.16

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.15

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.14

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.13

### Changes

- Version alignment with core OpenClaw release numbers.
## 2026.2.9

### Features

- Added `sessionScope` config for inbound Matrix routing:
  - `room` (default): preserve per-room session history.
  - `agent`: share one Matrix session across rooms for the same agent (`agent:{agentId}:matrix:main`).
- Added thread-isolated session keys for room thread traffic (`:thread:{threadRootId}`) with `ParentSessionKey` linking back to the base room/agent session.
- Wired resolved session keys through inbound context creation, session persistence, and system event enqueueing so thread and non-thread conversations remain isolated.
- Added unit coverage for `sessionScope` schema validation and session-key resolution behavior (room default, agent scope, room-thread isolation, DM non-thread behavior).

## 2026.2.6-3

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.6-2

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.6

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.4

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.2

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.31

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.30

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.29

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.23

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.22

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.21

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.20

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.17-1

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.17

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.16

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.15

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.14

### Features

- Version alignment with core OpenClaw release numbers.
- Matrix channel plugin with homeserver + user ID auth (access token or password login with device name).
- Direct messages with pairing/allowlist/open/disabled policies and allowFrom support.
- Group/room controls: allowlist policy, per-room config, mention gating, auto-reply, per-room skills/system prompts.
- Threads: replyToMode controls and thread replies (off/inbound/always).
- Messaging: text chunking, media uploads with size caps, reactions, polls, typing, and message edits/deletes.
- Actions: read messages, list/remove reactions, pin/unpin/list pins, member info, room info.
- Auto-join invites with allowlist support.
- Status + probe reporting for health checks.
