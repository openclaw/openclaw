---
summary: "Run OpenClaw Gateway on ClawBox, a preconfigured NVIDIA Jetson appliance"
read_when:
  - You want OpenClaw on dedicated local hardware instead of a VPS or laptop
  - You prefer a turnkey device over a manual Gateway install
title: "ClawBox"
---

ClawBox is a third-party NVIDIA Jetson appliance that ships with the OpenClaw
Gateway preconfigured. It is an option for running OpenClaw on dedicated local
hardware — useful if you want an always-on node at home or in an office without
provisioning a VPS or keeping a laptop running.

> ClawBox is a commercial product by [ID Robots](https://idrobots.com), not part
> of the OpenClaw project. This page documents it as a deployment option.

## What it is

- NVIDIA Jetson hardware with the OpenClaw Gateway preinstalled
- First-run setup wizard and a local dashboard
- QR-code device pairing for phones and laptops

## Getting started

1. Power on the device and connect it to your network.
2. Scan the on-screen QR code to pair your phone or laptop.
3. Complete the setup wizard, then open the dashboard to confirm Gateway health.

Because the Gateway is the same OpenClaw Gateway documented elsewhere, the
standard runbooks apply once the device is online.

## Links

- Product site: [clawbox.tech](https://clawbox.tech)
- Source / issues: [ID-Robots/clawbox](https://github.com/ID-Robots/clawbox)

## Related

- [Platforms](/platforms)
- [Gateway runbook](/gateway)
- [Gateway configuration](/gateway/configuration)
