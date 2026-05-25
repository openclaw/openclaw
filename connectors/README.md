# ClaWorks OT Connectors

NDJSON stdio child processes managed by `ConnectorManager` (`packages/claworks-runtime/src/interfaces/connectors/`).

## Production vs simulation

- Production (`production_mode: true` or `CLAWORKS_PRODUCTION=1`): keep `simulate: false` and use live presets (`mqtt`, `opcua`, `modbus`) without `-simulate` suffixes.
- `claworks doctor --fix` / `pnpm claworks:repair` strips `*-simulate` presets and forces `simulate: false` in production.
- Dev-only: set `simulate: true` on a connector entry or use `CLAWORKS_*_SIMULATE=1` env vars (see `contrib/examples/*.env.example`).

## Production checklist (mqtt / opcua / modbus)

Before go-live, verify each OT connector:

| Step                   | mqtt                                                                                                     | opcua                                    | modbus                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Config preset          | `"preset": "mqtt"`, `"simulate": false`                                                                  | `"preset": "opcua"`, `"simulate": false` | `"preset": "modbus"`, `"simulate": false` |
| Runtime deps           | `npm install mqtt` in deploy image                                                                       | `pip install asyncua`                    | `pip install pymodbus`                    |
| Simulate env **unset** | `CLAWORKS_MQTT_SIMULATE` not `1`                                                                         | `CLAWORKS_OPCUA_SIMULATE=0`              | `CLAWORKS_MODBUS_SIMULATE=0`              |
| Endpoint env           | `CLAWORKS_MQTT_URL`, `CLAWORKS_MQTT_TOPIC`                                                               | `CLAWORKS_OPCUA_ENDPOINT`, node ids      | `CLAWORKS_MODBUS_HOST`, unit/register     |
| Doctor                 | `CLAWORKS_PRODUCT=1 claworks doctor` → no `connectors_simulate` / `connectors_simulate_preset` **error** | same                                     | same                                      |
| Repair                 | `claworks doctor --fix` strips `-simulate` presets and `simulate: true` when `production_mode=true`      | same                                     | same                                      |
| Smoke (no plant)       | `pnpm claworks:ot-dry-run`                                                                               | same                                     | same                                      |
| Live proof             | Subscribe/publish on plant broker; alarm → playbook                                                      | Read/write test nodes                    | Poll holding registers                    |

**Common mistakes**

- Leaving `connectors.echo` enabled in production (`connectors_echo_demo` doctor error).
- Using `mqtt-simulate` / `opcua-simulate` preset names with `production_mode: true`.
- Running init without `CLAWORKS_INIT_SECURE=1` — dev defaults keep echo + open API.

**database-poll** (optional): preset `database-poll`; set `CW_DB_URL`, `CW_DB_TABLE`, `CW_DB_POLL_MS`. Without `CW_DB_URL` the bridge runs in demo mode (synthetic rows) — not for production.

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
| `database-poll` | `database-poll/database-poll-bridge.mjs` | `CW_DB_URL` + `pg` or `better-sqlite3`; demo without URL     |
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
