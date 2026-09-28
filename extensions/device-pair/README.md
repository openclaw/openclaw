# Device Pairing

Connect OpenClaw devices to your Gateway with setup codes and QR codes. The
plugin adds `/pair` commands for creating codes, inspecting pending requests,
and approving device pairing from an authorized conversation.

## Get started

Your Gateway needs an authenticated address the new device can reach. In an
authorized chat, run `/pair` for a setup code or `/pair qr` for a QR code, then
connect from the OpenClaw mobile app's Gateway settings.

Use `/pair pending` to review outstanding requests and `/pair cleanup` to
invalidate unused codes when finished.

See the [pairing guide](https://docs.openclaw.ai/channels/pairing) for connection
requirements and approval behavior.
