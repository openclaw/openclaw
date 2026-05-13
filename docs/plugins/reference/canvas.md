---
summary: "Experimental Canvas control and A2UI rendering surfaces for paired nodes."
read_when:
  - You are installing, configuring, or auditing the canvas plugin
title: "Canvas plugin"
---

# Canvas plugin

Experimental Canvas control and A2UI rendering surfaces for paired nodes.

## Distribution

- Package: `@openclaw/canvas-plugin`
- Install route: included in OpenClaw

## Surface

contracts: tools

Managed Canvas documents are stored in SQLite plugin blob rows. Set
`plugins.entries.canvas.config.host.root` only when you intentionally want the
host to serve operator-managed files from a directory.
