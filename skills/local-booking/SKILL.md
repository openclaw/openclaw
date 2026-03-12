---
name: local-booking
description: >-
  Location-based local service search and booking assistant with native language support.
  Searches nearby services (photo studios, clinics, restaurants, salons, massage/spa, etc.)
  and helps book in the local language via message templates, AI phone call (Vapi), or phone scripts.
  Triggers: "근처 사진관 찾아줘", "병원 예약해줘", "마사지 예약", "식당 예약", "book nearby",
  "find restaurant near me", "예약 도와줘", "로컬 예약", "local booking".
  NOT for: online-only service subscriptions, flight/hotel booking (use dedicated travel tools),
  or e-commerce product orders.
---

# Local Service Booking

## 1. Location Detection (Auto → Manual fallback)

1. **Auto GPS first:** `nodes → location_get (desiredAccuracy: "balanced")`
   - Success → show "📍 현재 위치: {city}, {district} (오차 ±{accuracy}m)"
   - Accuracy > 500m → ask user to confirm or specify manually
2. **Manual fallback:** if GPS unavailable, ask for city/address/landmark
   - Convert to coords: `web_search → "{address} GPS coordinates"`
3. User can switch modes anytime ("현재 위치로 다시 찾아줘" / "위치를 바꿀게")

## 2. Country/Language Detection

Determine country from coords/city → apply local language + cultural norms.
See [references/country-profiles.md](references/country-profiles.md) for per-country details (language, tipping, preferred messenger, etiquette).

## 3. Search Nearby Services

```
web_search → "{service} near {location}" (count: 5)
```

- Use local-language search queries in parallel for better coverage (e.g., "tiệm massage gần Quận 1")
- **Note:** Brave Search has limited SEA country code support → include city/country name in query
- Supplement with `web_fetch` for hours, pricing, reviews
- Collect: name, address, phone, hours, price range, rating, distance

## 4. Present Results

Table format, minimum 3 options with ⭐ top recommendation and brief reasoning.

## 5. Booking Options

| Option | Method                               | Details                                                                         |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------- |
| **A**  | Native language message (copy-paste) | Templates in [references/booking-templates.md](references/booking-templates.md) |
| **B**  | AI phone call (Vapi)                 | Setup & API in [references/vapi-integration.md](references/vapi-integration.md) |
| **C**  | Phone script + pronunciation guide   | Romanized script for self-calling                                               |

Variables: `{service}`, `{date}`, `{time}`, `{guests}`, `{requests}`

## 6. Post-Booking Support

1. **Directions:** `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}`
2. **On-arrival phrases:** greeting, confirm booking, receipt, payment, thanks (local language + romanized)
3. **Cultural tips:** country-specific etiquette

## Tools

| Tool                   | Purpose                    |
| ---------------------- | -------------------------- |
| `nodes` (location_get) | Auto GPS                   |
| `web_search`           | Service search + geocoding |
| `web_fetch`            | Venue details              |
| `message` (send)       | Deliver results            |
| `exec` (curl)          | Vapi AI phone call         |
