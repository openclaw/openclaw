---
summary: "Session pruning: pag-trim ng tool-result para mabawasan ang paglobo ng context"
read_when:
  - Gusto mong bawasan ang paglaki ng LLM context mula sa mga output ng tool
  - Tina-tune mo ang agents.defaults.contextPruning
---

# Session Pruning

Session pruning trims **old tool results** from the in-memory context right before each LLM call. It does **not** rewrite the on-disk session history (`*.jsonl`).

## Kailan ito tumatakbo

- Kapag naka-enable ang `mode: "cache-ttl"` at ang huling Anthropic call para sa session ay mas luma kaysa `ttl`.
- Tanging ang mga mensaheng ipinapadala sa model para sa request na iyon ang naaapektuhan.
- Aktibo lang para sa Anthropic API calls (at OpenRouter Anthropic models).
- Para sa pinakamahusay na resulta, itugma ang `ttl` sa `cacheControlTtl` ng iyong model.
- Pagkatapos ng prune, nagre-reset ang TTL window kaya ang mga kasunod na request ay magtatago ng cache hanggang sa muling mag-expire ang `ttl`.

## Mga smart default (Anthropic)

- **OAuth o setup-token** profiles: i-enable ang `cache-ttl` pruning at itakda ang heartbeat sa `1h`.
- **API key** profiles: i-enable ang `cache-ttl` pruning, itakda ang heartbeat sa `30m`, at i-default ang `cacheControlTtl` sa `1h` sa mga Anthropic model.
- Kapag itinakda mo nang tahasan ang alinman sa mga value na ito, **hindi** ito io-override ng OpenClaw.

## Ano ang pinapabuti nito (gastos + behavior ng cache)

- **Why prune:** Anthropic prompt caching only applies within the TTL. If a session goes idle past the TTL, the next request re-caches the full prompt unless you trim it first.
- **Ano ang mas nagiging mura:** binabawasan ng pruning ang laki ng **cacheWrite** para sa unang request pagkatapos mag-expire ang TTL.
- **Bakit mahalaga ang pag-reset ng TTL:** kapag tumakbo ang pruning, nagre-reset ang cache window, kaya ang mga follow‑up request ay puwedeng mag-reuse ng bagong naka-cache na prompt sa halip na muling i-cache ang buong history.
- **Ano ang hindi nito ginagawa:** hindi nagdadagdag ng token o “doble” na gastos ang pruning; binabago lang nito kung ano ang naka-cache sa unang post‑TTL request.

## Ano ang puwedeng i-prune

- Mga mensaheng `toolResult` lang.
- Ang mga mensahe ng user + assistant ay **hindi kailanman** binabago.
- Ang huling `keepLastAssistants` na assistant messages ay protektado; ang mga tool result pagkatapos ng cutoff na iyon ay hindi pina-prune.
- Kung kulang ang assistant messages para maitatag ang cutoff, nilalaktawan ang pruning.
- Ang mga tool result na may **image blocks** ay nilalaktawan (hindi kailanman tine-trim/kini-clear).

## Pagtatantiya ng context window

Pruning uses an estimated context window (chars ≈ tokens × 4). The base window is resolved in this order:

1. `models.providers.*.models[].contextWindow` override.
2. Model definition `contextWindow` (mula sa model registry).
3. Default na `200000` tokens.

Kung naka-set ang `agents.defaults.contextTokens`, itinuturing itong cap (min) sa resolved window.

## Mode

### cache-ttl

- Tatakbo lang ang pruning kung ang huling Anthropic call ay mas luma kaysa `ttl` (default `5m`).
- Kapag tumakbo: kaparehong soft-trim + hard-clear behavior gaya ng dati.

## Soft vs hard pruning

- **Soft-trim**: para lang sa sobrang laking tool result.
  - Pinananatili ang head + tail, nag-iinsert ng `...`, at nagdadagdag ng note na may orihinal na laki.
  - Nilalaktawan ang mga result na may image blocks.
- **Hard-clear**: pinapalitan ang buong tool result ng `hardClear.placeholder`.

## Pagpili ng tool

- Sinusuportahan ng `tools.allow` / `tools.deny` ang `*` wildcards.
- Nauuna ang deny.
- Case-insensitive ang matching.
- Walang laman na allow list => lahat ng tool ay allowed.

## Pakikipag-ugnayan sa iba pang limitasyon

- Ang mga built-in na tool ay nagta-truncate na ng sarili nilang output; ang session pruning ay dagdag na layer na pumipigil sa mahahabang chat na makaipon ng sobrang tool output sa context ng model.
- Compaction is separate: compaction summarizes and persists, pruning is transient per request. See [/concepts/compaction](/concepts/compaction).

## Mga default (kapag naka-enable)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Mga halimbawa

Default (naka-off):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

I-enable ang TTL-aware pruning:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Limitahan ang pruning sa mga partikular na tool:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Tingnan ang config reference: [Gateway Configuration](/gateway/configuration)
