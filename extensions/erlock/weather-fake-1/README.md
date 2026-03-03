# Weather Fake 1

Demo OpenClaw plugin that provides a deterministic fake-weather tool.

- Plugin id: `weather-fake-1`
- Tool name: `weather_fake_1`
- Output is fake/demo data only (not real weather)

## Install / enable

From this repo workspace:

```bash
openclaw plugins install ./extensions/weather-fake-1
openclaw plugins enable weather-fake-1
```

Then restart Gateway.

## Tool usage

The plugin registers a single tool with this schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "city": { "type": "string" }
  },
  "required": ["city"]
}
```

Example call payload:

```json
{
  "city": "Beijing"
}
```

## Development

Run the plugin test:

```bash
pnpm test extensions/weather-fake-1/index.test.ts
```
