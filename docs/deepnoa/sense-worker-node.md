# Sense Worker Node

This note captures the minimum external-worker bridge from the T550 OpenClaw host to the Sense Windows worker.

## Intended worker endpoints

- `GET http://192.168.11.11:8787/health`
- `POST http://192.168.11.11:8787/execute`

## Current T550-side wrapper

- script: `scripts/dev/sense_worker.py`

### Health check

```bash
python3 scripts/dev/sense_worker.py health
```

### Execute test

```bash
python3 scripts/dev/sense_worker.py execute \
  --task summarize \
  --input "OpenClaw から Sense へ接続テスト" \
  --params-json {}
```

## Current OpenClaw extension

- extension: `extensions/sense-worker`
- tool: `sense-worker`
- client module: `extensions/sense-worker/src/client.ts`
- entry point: `extensions/sense-worker/src/tool.ts`

### Tool examples

Health:

```json
{
  "action": "health"
}
```

Execute:

```json
{
  "action": "execute",
  "task": "summarize",
  "input": "Large input to summarize",
  "params": {}
}
```

## Current payload contract

```json
{
  "task": "summarize",
  "input": "OpenClaw から Sense へ接続テスト",
  "params": {}
}
```

## Error handling

The client and tool normalize these failures:

- timeout
- connection failure
- invalid JSON response

The tool logs request/response metadata through the plugin logger and avoids dumping raw input by default.

## Current connection status

- LAN reachability from T550 to Sense works
- `GET /health` returns `{"status":"ok"}`
- `POST /execute` returns a successful summarize response
- the helper script and bundled extension both work from T550

## Safe integration path for OpenClaw

Start with the bundled optional tool instead of changing core config:

1. keep direct HTTP access in `extensions/sense-worker/src/client.ts`
2. keep `scripts/dev/sense_worker.py` as a manual probe/debug helper
3. let agents use the optional `sense-worker` tool for summarize / heavy offload
4. if the worker contract grows, later promote it into a deeper HTTP tool adapter or queue-backed worker service
