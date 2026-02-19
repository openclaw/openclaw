# feat(xmpp): Complete XMPP Channel Implementation

## Summary

This PR introduces a fully functional XMPP channel plugin for OpenClaw, built from scratch to support seamless integration with the main agent. It includes implementation of key XMPP extensions for a modern messaging experience.

## Key Features

- **Core Messaging**: Bidirectional message routing between XMPP clients and the OpenClaw agent.
- **XEP-0184 (Message Delivery Receipts)**: Automatically requests and acknowledges message delivery to ensure reliability.
- **XEP-0085 (Chat State Notifications)**: Sends "composing" states when the agent is processing a response, providing real-time feedback to users.
- **XEP-0363 (HTTP File Upload)**:
  - Enables file sharing by uploading local files to the XMPP server's HTTP upload service.
  - Implements slot request, file upload (PUT), and URL sharing.
  - Includes robust error handling and fallback to Out-of-Band Data (XEP-0066) for file URLs.
  - Validates file sizes against server-provided limits.
- **XEP-0066 (Out of Band Data)**: Parses inbound OOB data to handle file attachments from XMPP clients correctly.

## Technical Details

- **Dependency Management**:
  - Locked `ws` dependency to `^7.5.9` for compatibility and security updates.
  - Removed duplicate `@xmpp/client` dependency to prevent conflicts.
- **Configuration**:
  - Renamed `clawdbot.plugin.json` to `openclaw.plugin.json` in `smart-model-router` to strictly follow project naming conventions.
  - Updated internal state directory from `.clawdbot` to `.openclaw` for consistency.

## Verification

- **Manual Testing**: Verified messaging flow, receipt checks, chat state indicators, and file upload/download functionality with a standard XMPP client (e.g., Gajim/Conversations).
- **CI Checks**:
  - `pnpm format` & `pnpm lint` passed.
  - `pnpm check:docs` passed.
  - `pnpm check` passed locally.
