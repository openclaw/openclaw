# Linux Node

Add desktop notifications, camera capture, and location to a Linux OpenClaw
node. Each capability depends on the host's installed tools and permissions.

## Get started

Connect and pair the Linux node with your Gateway. Notifications require
`notify-send` and a desktop notification session. Camera capture requires
FFmpeg and camera access; location requires GeoClue and its `where-am-i` demo.

Camera and location are off by default. Enable the capabilities you need in the
plugin settings, restart the node service, and approve its updated command
surface on the Gateway.

See [Linux node capabilities](https://docs.openclaw.ai/platforms/linux#node-capabilities)
for configuration, host requirements, and camera authorization.
