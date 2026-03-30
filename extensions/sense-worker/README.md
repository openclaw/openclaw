# Sense Worker

Optional OpenClaw extension for delegating summarize or heavy tasks to a Sense worker node over LAN.

## Default worker URL

- `http://192.168.11.11:8787`

## Tool name

- `sense-worker`

## Example

```json
{
  "action": "execute",
  "task": "summarize",
  "input": "Large input to summarize",
  "params": {}
}
```
