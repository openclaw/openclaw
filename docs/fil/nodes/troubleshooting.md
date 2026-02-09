---
summary: "Pag-troubleshoot ng pagpapares ng node, mga kinakailangan sa foreground, mga pahintulot, at mga pagkabigo ng tool"
read_when:
  - Nakakonekta ang node pero pumapalya ang camera/canvas/screen/exec tools
  - Kailangan mo ang mental model ng pagpapares ng node kumpara sa mga approval
title: "Pag-troubleshoot ng Node"
---

# Pag-troubleshoot ng node

Gamitin ang pahinang ito kapag nakikita ang node sa status pero pumapalya ang mga tool ng node.

## Hagdan ng command

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Pagkatapos ay patakbuhin ang mga check na partikular sa node:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Mga senyales ng maayos na kalagayan:

- Nakakonekta at naka-pair ang node para sa role na `node`.
- Kasama sa `nodes describe` ang capability na tinatawag mo.
- Ipinapakita ng mga exec approval ang inaasahang mode/allowlist.

## Mga kinakailangan sa foreground

Ang `canvas.*`, `camera.*`, at `screen.*` ay foreground-only sa mga iOS/Android node.

Mabilis na check at ayos:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Kung makita mo ang `NODE_BACKGROUND_UNAVAILABLE`, dalhin ang node app sa foreground at subukang muli.

## Matrix ng mga pahintulot

| Capability                   | iOS                                                       | Android                                                   | macOS node app                                          | Karaniwang failure code        |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera (+ mic para sa audio ng clip)   | Camera (+ mic para sa audio ng clip)   | Camera (+ mic para sa audio ng clip) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Screen Recording (+ mic optional)      | Screen capture prompt (+ mic optional) | Screen Recording                                        | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using o Always (depende sa mode) | Foreground/Background na lokasyon batay sa mode           | Pahintulot sa lokasyon                                  | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (path ng host ng node)             | n/a (path ng host ng node)             | Kinakailangan ang exec approvals                        | `SYSTEM_RUN_DENIED`            |

## Pagpapares kumpara sa mga approval

Magkaibang gate ang mga ito:

1. **Pagpapares ng device**: makakakonekta ba ang node na ito sa Gateway?
2. **Exec approvals**: makakapagpatakbo ba ang node na ito ng isang partikular na shell command?

Mabilis na mga check:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Kung kulang ang pairing, aprubahan muna ang node device.
Kung maayos ang pairing ngunit pumapalya ang `system.run`, ayusin ang exec approvals/allowlist.

## Mga karaniwang error code ng node

- `NODE_BACKGROUND_UNAVAILABLE` → naka-background ang app; dalhin ito sa foreground.
- `CAMERA_DISABLED` → naka-disable ang camera toggle sa mga setting ng node.
- `*_PERMISSION_REQUIRED` → kulang/itinanggi ang pahintulot ng OS.
- `LOCATION_DISABLED` → naka-off ang location mode.
- `LOCATION_PERMISSION_REQUIRED` → hindi ibinigay ang hiniling na location mode.
- `LOCATION_BACKGROUND_UNAVAILABLE` → naka-background ang app pero While Using lang ang pahintulot.
- `SYSTEM_RUN_DENIED: approval required` → kailangan ng exec request ng tahasang approval.
- `SYSTEM_RUN_DENIED: allowlist miss` → na-block ang command ng allowlist mode.

## Mabilis na recovery loop

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Kung hindi pa rin maayos:

- Muling i-approve ang pagpapares ng device.
- Buksan muli ang node app (foreground).
- Muling ibigay ang mga pahintulot ng OS.
- Likhain muli/ayusin ang patakaran ng exec approval.

Kaugnay:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
