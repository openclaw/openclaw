---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Inbound channel location parsing (Telegram + WhatsApp) and context fields"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying channel location parsing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Using location context fields in agent prompts or tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Channel Location Parsing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Channel location parsing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw normalizes shared locations from chat channels into:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- human-readable text appended to the inbound body, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- structured fields in the auto-reply context payload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Currently supported:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telegram** (location pins + venues + live locations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **WhatsApp** (locationMessage + liveLocationMessage)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Matrix** (`m.location` with `geo_uri`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Text formatting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Locations are rendered as friendly lines without brackets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `📍 48.858844, 2.294351 ±12m`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Named place:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Live share:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `🛰 Live location: 48.858844, 2.294351 ±12m`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the channel includes a caption/comment, it is appended on the next line:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
📍 48.858844, 2.294351 ±12m（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Meet here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a location is present, these fields are added to `ctx`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationLat` (number)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationLon` (number)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationAccuracy` (number, meters; optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationName` (string; optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationAddress` (string; optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationSource` (`pin | place | live`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LocationIsLive` (boolean)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channel notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telegram**: venues map to `LocationName/LocationAddress`; live locations use `live_period`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **WhatsApp**: `locationMessage.comment` and `liveLocationMessage.caption` are appended as the caption line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Matrix**: `geo_uri` is parsed as a pin location; altitude is ignored and `LocationIsLive` is always false.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
