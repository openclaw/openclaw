---
summary: "Channel location parsing and portable outbound location payloads"
read_when:
  - Adding or modifying channel location parsing
  - Using location context fields in agent prompts or tools
title: "Channel location parsing"
---

OpenClaw normalizes shared locations from chat channels into:

- terse coordinate text appended to the inbound body, and
- structured fields in the auto-reply context payload. Channel-provided labels, addresses, and captions/comments are rendered into the prompt by the shared untrusted metadata JSON block, not inline in the user body.

Currently supported:

- **LINE** (location messages with title/address)
- **Matrix** (`m.location` with `geo_uri`)
- **Telegram** (location pins + venues + live locations)
- **WhatsApp** (`locationMessage` + `liveLocationMessage`)

## Text formatting

Locations are rendered as friendly lines without brackets. Coordinates use six decimal places. Accuracy is rounded to whole meters:

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- Named place (same line, and the name/address go to the metadata block only):
  - `📍 48.858844, 2.294351 ±12m`
- Live share:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

If the channel includes a label, address, or caption/comment, the context payload keeps it. The prompt shows it as fenced untrusted JSON, and omits fields that are absent:

````text
Location:
```json
{
  "latitude": 48.858844,
  "longitude": 2.294351,
  "accuracy_m": 12,
  "source": "place",
  "name": "Eiffel Tower",
  "address": "Champ de Mars, Paris",
  "caption": "Meet here"
}
```
````

## Context fields

When a location is present, these fields are added to `ctx`:

- `LocationLat` (number)
- `LocationLon` (number)
- `LocationAccuracy` (number, meters, optional)
- `LocationName` (string, optional)
- `LocationAddress` (string, optional)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)
- `LocationCaption` (string, optional)

When the channel does not set an explicit source, OpenClaw infers it. Live shares become `live`. Locations with a name or address become `place`. Everything else is `pin`.

The prompt renderer treats `LocationName`, `LocationAddress`, and `LocationCaption` as untrusted metadata and serializes them through the same bounded JSON path used for other channel context.

## Outbound payloads

The message tool and Plugin SDK use the same `NormalizedLocation` shape for portable outbound locations. A coordinate-only payload represents a pin. Channels with native venue support may map `name` plus `address` to a venue card.

Telegram currently exposes this through `message(action="send")`. Its first implementation is deliberately standalone. Location payloads cannot be mixed with text or media. Incomplete venue pairs fail instead of silently dropping a name or address. Unsupported channels do not advertise the location parameter.

## Channel notes

- **LINE**: location message `title`/`address` map to `LocationName`/`LocationAddress`. LINE does not support live locations.
- **Matrix**: `geo_uri` is parsed as a pin location. The `u` (uncertainty) parameter maps to `LocationAccuracy`, the event body populates `LocationCaption`, altitude is ignored, and `LocationIsLive` is always false.
- **Telegram**: venues map to `LocationName`/`LocationAddress`. Live locations are detected via `live_period`.
- **WhatsApp**: `locationMessage.comment` and `liveLocationMessage.caption` populate `LocationCaption`.

## Related

- [Location command (nodes)](/nodes/location-command)
- [Camera capture](/nodes/camera)
- [Media understanding](/nodes/media-understanding)
