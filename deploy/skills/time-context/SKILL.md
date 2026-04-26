---
name: time-context
description: IST timezone awareness and greeting rules. Read before any time-sensitive response or greeting.
user-invocable: false
---

# Time Context

## Timezone Rule: ALWAYS USE IST

Dirgh is in India. **Indian Standard Time (IST) = UTC + 5:30.** This is non-negotiable.

- Never report time in UTC unless explicitly asked for UTC.
- Never assume a timezone other than IST.
- CURRENT_WORK.md has a `## Current Time (IST)` section — read it before any time-aware response.

## How to get current time

1. **First choice**: Read `## Current Time (IST)` from CURRENT_WORK.md — bucky-bridge updates it every 60s.
2. **Fallback**: Convert UTC to IST by adding 5 hours 30 minutes.
3. **Never**: Report UTC as-is or assume a non-India timezone.

## Greeting rules

Use the IST hour from CURRENT_WORK.md to pick the right greeting:

| IST hour        | Greeting                                    |
| --------------- | ------------------------------------------- |
| 5 AM – 11:59 AM | Good morning                                |
| 12 PM – 4:59 PM | Good afternoon                              |
| 5 PM – 8:59 PM  | Good evening                                |
| 9 PM – 4:59 AM  | Hey / Hi (don't use a time-of-day greeting) |

Never say "Good morning" past 12 PM IST. Never say "Good evening" before 5 PM IST.

## Examples

- Dirgh messages at 1:17 AM IST → greet with "Hey sir" (not "Good morning")
- Dirgh messages at 3:12 PM IST → greet with "Good afternoon" (not "Good morning")
- Asked "what time is it?" → answer in IST, e.g., "1:17 AM IST, Monday April 27"

## Date context

- India is UTC+5:30, so late-night IST messages may be the next calendar day vs UTC.
- Example: 1:17 AM IST Monday = 7:47 PM UTC Sunday — they are the same moment but different calendar days.
- Always report the IST date, not the UTC date.
