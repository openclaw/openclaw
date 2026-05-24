# ClaWorks OT Connectors

NDJSON stdio child processes managed by `ConnectorManager` (`packages/claworks-runtime/src/interfaces/connectors/`).

## Production vs simulation

- Production (`production_mode: true` or `CLAWORKS_PRODUCTION=1`): keep `simulate: false` and use live presets (`mqtt`, `opcua`, `modbus`) without `-simulate` suffixes.
- `claworks doctor --fix` / `pnpm claworks:repair` strips `*-simulate` presets and forces `simulate: false` in production.
- Dev-only: set `simulate: true` on a connector entry or use `CLAWORKS_*_SIMULATE=1` env vars (see `contrib/examples/*.env.example`).

## Built-in presets

Configure in `claworks.json` under `plugins.entries.claworks-robot.config.connectors`:

```json
{
  "connectors": {
    "plant-mqtt": {
      "preset": "mqtt",
      "simulate": false,
      "env": { "CLAWORKS_MQTT_URL": "mqtt://127.0.0.1:1883" }
    },
    "scada-poll": {
      "preset": "rest-poll",
      "env": {
        "CLAWORKS_REST_POLL_URL": "http://127.0.0.1:9090/api/tags",
        "CLAWORKS_REST_POLL_INTERVAL_MS": "10000"
      }
    }
  }
}
```

| Preset          | Bridge                                   | Live mode                                                    |
| --------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `echo`          | `echo/echo-bridge.mjs`                   | test only                                                    |
| `rest-poll`     | `rest-poll/rest-poll-bridge.mjs`         | HTTP polling                                                 |
| `mqtt`          | `mqtt/mqtt-bridge.mjs`                   | `npm install mqtt` + unset `CLAWORKS_MQTT_SIMULATE`          |
| `opcua`         | `opcua/opcua-bridge.py`                  | `pip install asyncua` + `CLAWORKS_OPCUA_SIMULATE=0`          |
| `modbus`        | `modbus/modbus-bridge.py`                | `pip install pymodbus` + `CLAWORKS_MODBUS_SIMULATE=0`        |
| `filesystem-kb` | `filesystem-kb/filesystem-kb-bridge.mjs` | `CLAWORKS_KB_WATCH_DIRS`; auto_start; emits `kb.folder_sync` |

## Invoke from REST

```bash
curl -X POST http://127.0.0.1:18800/v1/connectors/opcua/invoke \
  -H 'Content-Type: application/json' \
  -d '{"method":"simulate_alarm","params":{"payload":{"alarm_id":"x","mro_alarm_to_wo":true}}}'
```

## Playbook atomic steps

- `connector.invoke` — `connector_id`, `method`, `params`
- `a2a.send` — `target_url`, `message`, optional `metadata`

## Demo connectors init

```bash
CLAWORKS_DEMO_CONNECTORS=1 CLAWORKS_INIT_FORCE=1 pnpm claworks:init
```
