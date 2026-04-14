---
name: line-weather-interactive
description: "Verify LINE interactive buttons (postback) flow. Use when you need a 2-step click interaction (unit -> city) and then fetch live weather via Open-Meteo (no API key)."
homepage: https://open-meteo.com/
metadata: { "openclaw": { "emoji": "🌦️" } }
---

# LINE Interactive Weather Validation Skill

Use this skill to quickly validate that LINE interactive components (buttons with postback) can round-trip into the agent/skill message pipeline.

## Goal

Create a 2-step selection flow:

1) Ask for temperature unit: Celsius or Fahrenheit (LINE buttons).
2) Ask for a city: Beijing, Tokyo, New York (LINE buttons).
3) Fetch current weather from Open-Meteo and reply with a short summary.

## Important constraints

- This validation is intended to run on the **LINE** channel.
- Use LINE button directives (`[[buttons: ...]]`) so OpenClaw renders a LINE template message.
- Button payloads should use **postback data** (must contain `=`) so LINE sends a `postback` event.
- The inbound postback will arrive as user text (the raw postback string), so treat it as the user reply.

## Interaction protocol

Use these postback payload formats:

- Unit choice:
  - `wx.unit=c`
  - `wx.unit=f`

- City choice:
  - `wx.city=beijing`
  - `wx.city=tokyo`
  - `wx.city=new_york`

## How to run (user-facing)

When the user asks to test the LINE interactive flow, instruct them to say:

- `test line weather`

(or equivalent; do not require a strict command name).

## Agent behavior

Follow this exact flow.

### Step 0: Detect start or reset

If the user message contains something like:

- `test line weather`
- `line weather`
- `reset weather`

then start a new flow.

### Step 1: Ask for unit (buttons)

Send a message that includes a LINE buttons directive with **postback** payloads:

- Use exactly this pattern:

  `Choose temperature unit. [[buttons: Weather | Pick a unit | Celsius:wx.unit=c, Fahrenheit:wx.unit=f]]`

Notes:

- Keep the visible text concise.
- The directive will render a LINE buttons template with 2 actions.

### Step 2: Receive unit selection

If the next user message matches either:

- `wx.unit=c`
- `wx.unit=f`

then:

1) Save the selected unit in the conversation context as `unit` (`c` or `f`).
2) Ask for city selection using LINE buttons:

   `Choose a city. [[buttons: Weather | Pick a city | Beijing:wx.city=beijing, Tokyo:wx.city=tokyo, New York:wx.city=new_york]]`

### Step 3: Receive city selection

If the next user message matches one of:

- `wx.city=beijing`
- `wx.city=tokyo`
- `wx.city=new_york`

then:

1) Save the selected city in the conversation context as `city`.
2) Fetch weather from Open-Meteo using `web_fetch`.

Use these coordinates:

- Beijing: `39.9042,116.4074`
- Tokyo: `35.6762,139.6503`
- New York: `40.7128,-74.0060`

Open-Meteo request:

- Celsius:
  - `https://api.open-meteo.com/v1/forecast?latitude=<LAT>&longitude=<LON>&current_weather=true&temperature_unit=celsius`
- Fahrenheit:
  - `https://api.open-meteo.com/v1/forecast?latitude=<LAT>&longitude=<LON>&current_weather=true&temperature_unit=fahrenheit`

Call:

- `web_fetch` with `extractMode=text` and a reasonable `maxChars` (e.g. 5000).

Then parse the JSON and extract:

- `current_weather.temperature`
- `current_weather.windspeed`
- `current_weather.weathercode` (optional; you can omit decoding if you want)

### Step 4: Reply with result

Reply with a concise single message, for example:

- `Beijing: 21°C, wind 3.4 m/s`

Include the unit symbol based on the selection.

### Fallbacks

- If the user replies with free text like `c`/`f` or `celsius`/`fahrenheit`, interpret it as the unit.
- If the user replies with a city name (Chinese or English), map it to the three supported cities.
- If the user clicks a button but the inbound text does not match the expected `wx.*=...` formats, reply:

  `I received a LINE callback but could not parse it. Please tap a button again, or type one of: wx.unit=c, wx.unit=f, wx.city=beijing, wx.city=tokyo, wx.city=new_york`

## Expected validation result (what you should observe)

- After sending the first message, LINE shows a buttons template.
- Tapping a button generates a `postback` event.
- OpenClaw delivers the postback payload string to the agent as a new inbound message.
- The agent continues the flow and asks the next question (city buttons).
- After choosing a city, the agent fetches Open-Meteo and replies with the live weather.
