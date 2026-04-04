# VeriClaw 爪印 Privacy

VeriClaw 爪印 is designed as a local-first verification companion for a user-controlled OpenClaw Gateway.

## What the app processes

- Pairing details needed to connect your device to your chosen gateway
- Content you explicitly share, capture, or approve for review flows
- Optional device signals you enable, such as camera, microphone, photo library, notifications, motion, and location
- Operational state needed to keep the companion connected and deliver review actions

## Where data goes

- By default, VeriClaw 爪印 sends data only to the OpenClaw Gateway you pair it with
- The app does not require a hosted VeriClaw account to function
- If your paired gateway routes data to third-party providers or automations, that routing is controlled by your gateway configuration rather than by the App Store client alone

## Sharing

- Device data is shared with your paired OpenClaw Gateway only when a feature is enabled and a workflow requests it
- Any onward sharing to model providers, third-party services, or external automations is determined by your gateway configuration
- VeriClaw 爪印 does not promise a separate hosted cloud account layer for routing or storage

## Permissions

VeriClaw 爪印 requests only the permissions needed for features you use, including:

- Camera and photos for evidence capture
- Microphone and speech recognition for voice-triggered workflows
- Location and motion for device-aware verification workflows
- Notifications for review prompts and companion actions

## Data control

- You control the gateway, pairing, and enabled device capabilities
- You can disconnect the gateway, revoke permissions, or remove local app data through your device settings and paired runtime setup

## Retention and deletion

- Local app state is retained only as long as needed to keep pairing, review, and notification flows working on your device
- Gateway-side retention is controlled by the OpenClaw runtime you pair with
- To stop future collection from this device, disconnect the gateway pairing, revoke permissions, or remove the app and its local data

## Support

For current support and release materials, see [SUPPORT.md](SUPPORT.md).
