---
summary: "Run the OpenClaw Gateway on ClawBox, a third-party NVIDIA Jetson appliance"
read_when:
  - You want to run OpenClaw on dedicated local hardware instead of a VPS or laptop
  - You prefer a preconfigured device over a manual Gateway install
title: "ClawBox"
---

ClawBox is a third-party NVIDIA Jetson appliance that ships with the OpenClaw
Gateway preinstalled. It is one way to run OpenClaw on dedicated local hardware —
for example, an always-on node on your own network instead of a VPS or a laptop
left running.

> ClawBox is a commercial product by [ID Robots](https://idrobots.com), not part
> of the OpenClaw project. This page documents it as a deployment option; the
> device itself is supported by its vendor, not by the OpenClaw maintainers.

## What it is

- NVIDIA Jetson hardware with the OpenClaw Gateway preinstalled
- A first-run setup wizard and a local dashboard
- QR-code pairing for phones and laptops

## Relationship to a manual Gateway install

ClawBox runs the same OpenClaw Gateway documented elsewhere — it is not a fork or
a reduced build. Once the device is online:

- Gateway configuration lives in the standard location, so the existing
  [Gateway runbook](/gateway) and [Gateway configuration](/gateway/configuration)
  docs apply unchanged.
- Anything you can do with a self-hosted Gateway — pairing clients, managing
  tokens, connecting tools — works the same way.

The device changes *how the Gateway is provisioned* (preinstalled on hardware),
not how OpenClaw behaves once it is running.

## Getting started

1. Power on the device and connect it to your network.
2. Scan the on-screen QR code to pair your phone or laptop.
3. Complete the setup wizard, then open the dashboard to confirm Gateway health.

## Support

- Hardware, setup, and device updates: [ID-Robots/clawbox](https://github.com/ID-Robots/clawbox) or [clawbox.tech](https://clawbox.tech)
- The OpenClaw Gateway itself: the standard OpenClaw support channels.

## Related

- [Platforms](/platforms)
- [Gateway runbook](/gateway)
- [Gateway configuration](/gateway/configuration)
