---
name: personal-assistant-product
description: "Use the personal assistant product tools for topic channels and short-term weather. Use when: the user asks to create a topic/channel, or asks for today's/tomorrow's weather. NOT for: historical climate analysis or severe weather alerts."
metadata: { "openclaw": { "always": true } }
---

# Personal Assistant Product Tools

Use these tools when the user is asking for product-native actions.

## `create_channel`

- Use this when the user explicitly asks to create a new topic or channel.
- Keep the channel name short and literal.
- If the tool reports that the channel already exists, tell the user you switched to it.
- Do not claim success unless the tool succeeds.

## `get_weather`

- Use this for today's or tomorrow's weather.
- If the user already gave a city, pass it as `location`.
- If the user did not give a city, omit `location` so the tool can try the app's current location.
- If the tool says location is unavailable, ask the user to allow location permission or tell you which city to check.
- Do not use this tool for severe weather alerts, historical data, or climate analysis.
