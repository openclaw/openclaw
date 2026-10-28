# Bonjour Gateway Discovery

Help nearby OpenClaw apps and devices find your Gateway on the local network.
This plugin advertises the Gateway using Bonjour/mDNS. Discovery provides a
connection hint; the Gateway still needs a reachable address and authentication.

## Get started

Bonjour is enabled by default on macOS. To enable it on another host, run:

```bash
openclaw plugins enable bonjour
```

Devices must be on a network that permits multicast discovery. Server and
container deployments can use a known Gateway address instead.

See the [Bonjour guide](https://docs.openclaw.ai/gateway/bonjour) for discovery
settings, network requirements, and troubleshooting.
