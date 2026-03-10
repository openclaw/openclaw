# Changelog

## 2026.3.9

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.3.8-beta.1

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.3.8

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.3.7

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.3.3

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.3.2

### Changes

- Rebuilt the plugin to use native `zca-js` integration inside OpenClaw (no external `zca` CLI runtime dependency).

### Breaking

- **BREAKING:** Removed the old external CLI-based backend (`zca`/`openzca`/`zca-cli`) from runtime flow. Existing setups that depended on external CLI binaries should re-login with `openclaw channels login --channel zalouser` after upgrading.

## 2026.3.1

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.26

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.25

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.24

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.2.22

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.1.17-1

- Initial version with full channel plugin support
- QR code login via zca-cli
- Multi-account support
- Agent tool for sending messages
- Group and DM policy support
- ChannelDock for lightweight shared metadata
- Zod-based config schema validation
- Setup adapter for programmatic configuration
- Dedicated probe and status issues modules
