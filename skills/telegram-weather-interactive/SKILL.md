---
name: telegram-weather-interactive
description: "Verify Telegram inline keyboard callbacks flow into the agent/skill pipeline. 2-step click interaction (unit -> city) and then fetch live weather via Open-Meteo (no API key)."
homepage: https://open-meteo.com/
metadata: { "openclaw": { "emoji": "🌤️" } }
---

# Telegram Interactive Weather Validation Skill

Use this skill to quickly validate that Telegram inline keyboard button clicks (callback_data) round-trip into the agent/skill message pipeline.

## Goal

Create a 2-step selection flow:

1. Ask for temperature unit: Celsius or Fahrenheit (Telegram inline keyboard).
2. Ask for a city: Beijing, Tokyo, New York (Telegram inline keyboard).
3. Fetch current weather from Open-Meteo and reply with a short summary.

## Important constraints

- This validation is intended to run on the **Telegram** channel.
- Use Telegram inline keyboard buttons (`buttons` with `callback_data`).
- In OpenClaw, Telegram `callback_query.data` is converted into a synthetic inbound text message and processed by the normal inbound pipeline. Treat the callback payload as the user's reply.

## Interaction protocol

Use callback payload formats that include a **skill trigger prefix** so every click reliably re-triggers this skill.

Recommended prefix:

- `test tg weather`

Use these callback payload formats:

- Unit choice:
  - `test tg weather wx.unit=c`
  - `test tg weather wx.unit=f`

- City choice:
  - `test tg weather wx.city=beijing`
  - `test tg weather wx.city=tokyo`
  - `test tg weather wx.city=new_york`

## How to run (user-facing)

When the user asks to test the Telegram interactive flow, instruct them to say:

- `test tg weather`

(or equivalent; do not require a strict command name).

## Agent behavior

Follow this exact flow.

## Debug mode (recommended for validation)

For this validation run, you should **echo the exact raw user input** you received after every click.

Use this format:

- `DEBUG: received="<RAW>"`

Where `<RAW>` is the exact user message text you received (including any `wx.*=...` payload).

### Step 0: Detect start or reset

If the user message contains something like:

- `test tg weather`
- `tg weather`
- `reset weather`

then start a new flow.

### Step 1: Ask for unit (inline keyboard)

Send a message with two Telegram inline buttons.

Use the `message` tool with:

- `action=send`
- `message="Choose temperature unit."`
- `buttons` set to an array of button rows.

Buttons payload (single row, two buttons):

- Button label text must be exactly `Celsius` and `Fahrenheit` (do not embed payload text in the label).
- `callback_data` must be exactly `test tg weather wx.unit=c` and `test tg weather wx.unit=f`.

### Step 2: Receive unit selection

If the next user message contains a unit callback (contains `wx.unit=`), treat it as the unit selection.

Accepted examples:

- `test tg weather wx.unit=c`
- `test tg weather wx.unit=f`
- `test tg weather wx.unit=celsius` (typo-tolerant)
- `test tg weather wx.unit=chelfius` (typo-tolerant)

then:

1. Immediately reply with the debug echo:

   `DEBUG: received="<RAW>"`

2. Parse and save the selected unit in the conversation context as `unit`.

   Parsing rules:
   - If the payload contains `=c` or ends with `=c`, set `unit=c`.
   - If the payload contains `=f` or ends with `=f`, set `unit=f`.
   - Else if the payload contains `c`/`cel` (case-insensitive), set `unit=c`.
   - Else if the payload contains `f`/`fahr` (case-insensitive), set `unit=f`.
   - If still ambiguous, ask the user to tap again.

3. Ask for city selection using Telegram inline buttons (one row or multiple rows):

- `Beijing` with `callback_data=test tg weather wx.city=beijing`
- `Tokyo` with `callback_data=test tg weather wx.city=tokyo`
- `New York` with `callback_data=test tg weather wx.city=new_york`

Button label text must be exactly `Beijing`, `Tokyo`, `New York` (do not embed payload text in the label).

### Step 3: Receive city selection

If the next user message contains a city callback (contains `wx.city=`), treat it as the city selection.

Accepted examples:

- `test tg weather wx.city=beijing`
- `test tg weather wx.city=tokyo`
- `test tg weather wx.city=new_york`

then:

1. Immediately reply with the debug echo:

   `DEBUG: received="<RAW>"`

2. Parse and save the selected city in the conversation context as `city`.

   Parsing rules:
   - If payload contains `beijing`, set `city=beijing`.
   - If payload contains `tokyo`, set `city=tokyo`.
   - If payload contains `new_york` or `newyork`, set `city=new_york`.
   - If still ambiguous, ask the user to tap again.

3. Fetch weather from Open-Meteo using `web_fetch`.

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

  `I received a Telegram callback but could not parse it. Please tap a button again, or type one of: wx.unit=c, wx.unit=f, wx.city=beijing, wx.city=tokyo, wx.city=new_york`

## Expected validation result (what you should observe)

- After sending the first message, Telegram shows inline keyboard buttons.
- Tapping a button sends a callback query.
- OpenClaw converts the callback payload into a synthetic inbound text message.
- The agent continues the flow and asks the next question (city buttons).
- After choosing a city, the agent fetches Open-Meteo and replies with the live weather.
