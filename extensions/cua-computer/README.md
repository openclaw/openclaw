# CUA Computer

Experimental computer control through CUA Driver. OpenClaw can observe and
interact with a Gateway desktop or a paired computer. Available actions depend
on the host, driver, and granted permissions.

## Get started

On macOS, choose **CUA** under **Settings → This Mac → Capabilities** in the
OpenClaw app and grant Accessibility and Screen Recording access.

On a supported Windows or Linux host, enable the plugin and check its driver:

```bash
openclaw plugins enable cua-computer
openclaw doctor --lint --only cua-computer/driver-artifacts
```

You also need a vision-capable model and tool policy that permits computer use.
See the [computer use guide](https://docs.openclaw.ai/nodes/computer-use) for host
requirements, pairing, and permissions.

## Native session expiry

Before dispatching computer input or capture, the native adapter checks its trusted
session. A positively identified authorization expiry replaces the native session
with the same fixed permission and TTL ceilings. Old frame, window, and browser
references are revoked; take a fresh screenshot or observation before using them.
The requested input is never replayed during recovery, and other permission
refusals are reported rather than automatically reauthorized.

An active recording ends with the old native session and must be explicitly
restarted. Its captured resources remain execution-owned until normal cleanup.
