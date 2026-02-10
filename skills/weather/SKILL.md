---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: weather（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Get current weather and forecasts (no API key required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://wttr.in/:help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "emoji": "🌤️", "requires": { "bins": ["curl"] } } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Weather（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two free services, no API keys needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## wttr.in (primary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick one-liner:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s "wttr.in/London?format=3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Output: London: ⛅️ +8°C（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Compact format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s "wttr.in/London?format=%l:+%c+%t+%h+%w"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Output: London: ⛅️ +8°C 71% ↙5km/h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full forecast:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s "wttr.in/London?T"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format codes: `%c` condition · `%t` temp · `%h` humidity · `%w` wind · `%l` location · `%m` moon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tips:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- URL-encode spaces: `wttr.in/New+York`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Airport codes: `wttr.in/JFK`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Units: `?m` (metric) `?u` (USCS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Today only: `?1` · Current only: `?0`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PNG: `curl -s "wttr.in/Berlin.png" -o /tmp/weather.png`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open-Meteo (fallback, JSON)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Free, no key, good for programmatic use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Find coordinates for a city, then query. Returns JSON with temp, windspeed, weathercode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: https://open-meteo.com/en/docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
