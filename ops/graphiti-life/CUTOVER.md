# Phase 3 cutover runbook — wire Graphiti memory into the `life` agent

Applies the per-user memory feature to the live `life` gateway on the US host
(`5.161.84.219`). All steps are reversible; backups are taken first.

> **Live-bot side effect:** setting `session.dmScope = per-peer` changes Telegram
> DM session keys from a single shared `…:main` session to one per sender. Existing
> in-flight DM conversations effectively start a fresh session thread. This is
> required for per-user memory (the default `main` scope has no user identity).

## 0. Prereqs (already done in Phase 1/2)

- `graphiti-life` compose stack healthy on the host (`/opt/graphiti`).
- Proxy validated; identity hook written.

## 1. Connect the life container to Graphiti's network

```bash
docker network connect graphiti-life_graphiti life-openclaw-gateway-1
# verify the proxy host resolves from inside life:
docker exec life-openclaw-gateway-1 getent hosts graphiti-mcp
```

(Re-run after any `docker compose up` that recreates the life container.)

## 2. Install the extensions into life's config dir

```bash
# proxy (CommonJS, own dir)
mkdir -p /root/.openclaw/agents/life/extensions/graphiti-proxy
cp proxy/graphiti-proxy.js proxy/package.json \
   /root/.openclaw/agents/life/extensions/graphiti-proxy/
# identity hook plugin
cp -r extensions/life-memory-scope \
   /root/.openclaw/agents/life/extensions/
```

Container sees these at `/home/node/.openclaw/extensions/...`.

## 3. Edit `/root/.openclaw/agents/life/openclaw.json` (BACK UP FIRST)

```bash
cp openclaw.json openclaw.json.bak.pre-graphiti
```

Add/merge:

```jsonc
{
  "session": { "dmScope": "per-peer" },
  "plugins": {
    "entries": {
      "telegram": { "enabled": true },
      "life-memory-scope": { "enabled": true },
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": {
            "graphiti": {
              "command": "node",
              "args": ["/home/node/.openclaw/extensions/graphiti-proxy/graphiti-proxy.js"],
              "env": {
                "GRAPHITI_URL": "http://graphiti-mcp:8000/mcp",
                "GRAPHITI_HOST_HEADER": "localhost:8000",
              },
            },
          },
        },
      },
    },
  },
}
```

## 4. Teach the agent the memory protocol (prompt)

Append a concise protocol to the agent's `MEMORY.md` (workspace) — read-before /
write-after-raw, and that "show me my file" reads the per-user user-file, not memory.
The model sees the tools as `mcp__graphiti__add_memory`, `…__search_memory_facts`,
`…__search_nodes`, `…__get_episodes` (no group params — scope is automatic).

## 5. Restart the gateway

```bash
docker restart life-openclaw-gateway-1
docker logs life-openclaw-gateway-1 --tail 40 2>&1 | grep -iE "mcp-bridge|life-memory-scope|graphiti|error"
```

Expect: mcp-bridge starts "graphiti" with 4 tools; life-memory-scope hook registered.

## 6. Smoke test (per-channel + isolation) — see Phase 6 in the plan.

## Plugin-loading requirements (learned the hard way during cutover)

A first-party agent-extension plugin must satisfy ALL of these or the gateway
either ignores it or crash-loops on "Invalid config":

1. **`openclaw.plugin.json` must include `configSchema`** (an object). Missing it →
   "plugin manifest requires configSchema" → crash-loop. Use
   `{ "type": "object", "properties": {}, "additionalProperties": false }` if no config.
2. **Directory must be traversable by the container uid (1000):** `chmod 0755` the
   dir (a `0744` dir blocks discovery silently → "plugin not found"). `chown 1000:1000`.
3. **Register hooks with `api.on(hookName, handler, {priority})`, NOT
   `api.registerHook(...)`.** Only `api.on` feeds `registry.typedHooks`, which is what
   the tool-call path (`runBeforeToolCallHook` → `getGlobalHookRunner` →
   `hasHooks`) consults. `registerHook` lands in the file-based internal-hook bucket
   and never fires on tool calls (and needs `opts.name` or it no-ops).
4. **Enable the hook system:** agent config `hooks.internal.enabled = true`.
5. **Pin trust:** `plugins.allow = ["telegram","mcp-bridge","life-memory-scope"]`
   (else a warning + auto-load of discovered plugins).
6. **Per-run activation:** plugins activate per agent run, so the proxy is spawned
   and the hook re-registered on every message — this is normal, not a restart.

## Rollback

```bash
cp openclaw.json.bak.pre-graphiti openclaw.json
docker restart life-openclaw-gateway-1
docker network disconnect graphiti-life_graphiti life-openclaw-gateway-1   # optional
```
