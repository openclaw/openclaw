# SRE Bot Data Storage Patterns

> Persistent learned patterns and investigation outcomes for the morpho-sre bot.

## Storage Locations

| File                                                 | Purpose                                              | Format |
| ---------------------------------------------------- | ---------------------------------------------------- | ------ |
| `${CLAUDE_PLUGIN_DATA}/gotchas-learned.jsonl`        | Gotchas discovered during incidents                  | JSONL  |
| `${CLAUDE_PLUGIN_DATA}/false-positives.jsonl`        | Alert patterns confirmed as noise                    | JSONL  |
| `${CLAUDE_PLUGIN_DATA}/investigation-outcomes.jsonl` | Which evidence paths worked for which incident types | JSONL  |
| `${CLAUDE_PLUGIN_DATA}/skill-usage.jsonl`            | Script/reference invocation log                      | JSONL  |

## Schemas

### gotchas-learned.jsonl

```json
{
  "ts": "2026-03-18T12:00:00Z",
  "incident_id": "INC-42",
  "gotcha": "ethereum.blocks uses 'number' not 'block_number'",
  "category": "dune",
  "severity": "high",
  "source": "incident"
}
```

### false-positives.jsonl

```json
{
  "ts": "2026-03-18T12:00:00Z",
  "alert_pattern": "MorphoIndexerDelay on arbitrum during sequencer batch",
  "confirmed_noise": true,
  "reason": "Sequencer batching causes expected 2-5min gaps",
  "occurrences": 3
}
```

### investigation-outcomes.jsonl

```json
{"ts":"2026-03-18T12:00:00Z","incident_type":"db-stale-data","evidence_path":"db-evidence.sh --mode data","productive":true,"time_to_signal_sec":15}
{"ts":"2026-03-18T12:00:00Z","incident_type":"db-stale-data","evidence_path":"repo code inspection","productive":false,"time_to_signal_sec":180}
```

### skill-usage.jsonl

```json
{"ts":"2026-03-18T12:00:00Z","script":"sentinel-triage.sh","context":"heartbeat","duration_sec":45}
{"ts":"2026-03-18T12:00:00Z","reference":"db-first-incidents.md","context":"slack-thread"}
```

## Usage

### Appending a learned gotcha

```bash
DATADIR="${CLAUDE_PLUGIN_DATA:-/tmp/openclaw-sre-data}"
mkdir -p "$DATADIR"
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","incident_id":"INC-42","gotcha":"description","category":"cat","severity":"high","source":"incident"}' >> "$DATADIR/gotchas-learned.jsonl"
```

### Reading recent gotchas

```bash
tail -20 "${CLAUDE_PLUGIN_DATA:-/tmp/openclaw-sre-data}/gotchas-learned.jsonl" | jq -r '.gotcha'
```

### Periodic review

Review these files monthly to:

- Promote recurring gotchas into SKILL.md Gotchas section
- Remove resolved false positives
- Identify underused evidence paths
- Tune alert patterns
