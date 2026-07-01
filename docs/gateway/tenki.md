---
summary: "Run OpenClaw sandboxed tools inside Tenki Cloud sandboxes"
title: "Tenki sandbox backend"
sidebarTitle: "Tenki"
read_when: "You want OpenClaw agent tools to execute in Tenki Cloud sandboxes."
status: active
---

OpenClaw can use Tenki Cloud as a sandbox backend through the `tenki` plugin. The Gateway stays on the host; sandboxed `exec`, file tools, prompt media reads, and inbound media staging run against a Tenki sandbox over SSH.

Install with `openclaw plugins install @openclaw/tenki-sandbox`. The Tenki CLI must be authenticated on the Gateway host.
