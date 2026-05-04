# fake-max-server

Tiny `node:http` server that fakes `https://platform-api.max.ru` for the MAX
channel plugin's polling supervisor (Phase 1B). Each scenario is a JSON file
listing pre-baked HTTP responses; the server replays them in order for every
incoming `GET /updates` call.

This harness is the gating proof for **Phase 1B**: the supervisor lands when
each scenario in this directory drives the documented supervisor reaction
(see [`docs/max-plugin/plan.md`](../../../../docs/max-plugin/plan.md) §6.1.7).

## Programmatic use

```ts
import { startFakeMaxServer } from "./server.js";

const handle = await startFakeMaxServer({
  scenarioPath: "extensions/max-messenger/test/fake-max-server/scenarios/happy-path.json",
});
// Point the supervisor's `apiRoot` at handle.url, run, then:
await handle.stop();
```

`startFakeMaxServer({ scenarioPath, scenario?, port?, host? })` returns:

| field             | description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `url`             | `http://<host>:<port>` — point the supervisor's `apiRoot` here        |
| `port`            | bound port (resolved when `port: 0`)                                  |
| `getRequests()`   | observed requests (method, path, marker, timeout, limit, auth header) |
| `getAssertions()` | scenario-level soft assertions (e.g. `expectMarker` mismatches)       |
| `stop()`          | closes the listener and force-disconnects keep-alive sockets          |

## Manual CLI (local exploration)

```sh
pnpm tsx extensions/max-messenger/test/fake-max-server/server.ts \
  extensions/max-messenger/test/fake-max-server/scenarios/happy-path.json \
  --port 9999
```

Then point `channels.max-messenger.apiRoot` at `http://127.0.0.1:9999` in your
local `~/.openclaw/openclaw.json` and run `openclaw start` to drive the
supervisor against the fake server.

## Scenario JSON shape

```jsonc
{
  "description": "human-readable one-liner explaining the supervisor behavior under test",
  "responses": [
    {
      "status": 200, // optional, default 200
      "headers": { "Retry-After": "2" }, // optional
      "body": { "updates": [], "marker": 0 }, // optional; serialized as application/json
      "delayMs": 150, // optional — delay before sending headers
      "closeConnection": true, // optional — destroy the TCP socket pre-headers
      "repeat": 12, // optional — serve this entry N times in a row
      "expectMarker": 2000, // optional — soft-assert incoming marker
    },
  ],
  "exhaustionPolicy": "idle", // optional: "idle" (default) or "loop"
}
```

Edge cases the supervisor must handle without leaking are encoded as response
shape variants:

- **`closeConnection: true`** drops the TCP socket without sending headers.
  Models undici's `TypeError: fetch failed` (cause `AbortError`/`SocketError`)
  observed when the upstream MAX edge closes mid-poll.
- **`delayMs` > supervisor request timeout** triggers the supervisor's
  per-request `AbortSignal.timeout`. The body never arrives.
- **`repeat: N`** keeps long-outage scenarios concise — `repeat: 12` of a
  503 response covers >60s at the supervisor's exponential-backoff cap (30s).
- **`expectMarker`** logs a soft assertion when the incoming `marker` query
  param does not match. Tests inspect `handle.getAssertions()`.

## Scenarios shipped today

| File                        | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `happy-path.json`           | Single 200 batch; marker advances; supervisor dispatches one update                             |
| `429-with-retry-after.json` | Two 429 with `Retry-After: 2`, then 200; supervisor honors the header                           |
| `5xx-then-success.json`     | 500 → 502 → 503 → 200; exponential backoff doubles up to `maxBackoffMs`, resets on success      |
| `network-drop.json`         | Two `closeConnection`, then 200; supervisor classifies as transient `NetworkError`              |
| `slow-response.json`        | 60s delay; supervisor's request timeout fires and the loop treats it as transient               |
| `marker-replay.json`        | Same `mid` returned twice; dedup cache drops the duplicate, marker still advances on next batch |
| `401-revoked.json`          | Two 200 batches, then 401; supervisor halts loop, status `unauthorized`, emits `polling.fatal`  |
| `prolonged-outage.json`     | 12× 503 (>60s outage), then 200; supervisor stays alive, hits `maxBackoffMs`, resumes cleanly   |

## Adding a new scenario

1. Drop `<name>.json` into `scenarios/` matching the shape documented above.
2. Add the filename to `REQUIRED_SCENARIOS` in `scenarios.test.ts` if it should
   be enforced as part of the supervisor's gating proof.
3. Run `pnpm test extensions/max-messenger/test/fake-max-server` to confirm the
   harness loads it.
4. Add a matching supervisor integration test in
   `extensions/max-messenger/test/supervisor.integration.test.ts` once the
   supervisor itself lands (Phase 1B.1).

## Out of scope

This harness only covers the polling endpoint (`GET /updates`). Outbound
(`POST /messages`) and uploads return 501 today; they will be wired into the
same harness in Phase 1B.1 when the outbound adapter starts using the polling
HTTP wrapper. Webhook transport is Phase 2 territory and uses a separate
listener.
