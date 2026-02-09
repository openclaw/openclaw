---
summary: "Context window + compaction: paano pinananatili ng OpenClaw ang mga session sa loob ng limitasyon ng model"
read_when:
  - Gusto mong maunawaan ang auto-compaction at /compact
  - Nagde-debug ka ng mahahabang session na tumatama sa mga limitasyon ng context
title: "Compaction"
---

# Context Window & Compaction

Bawat modelo ay may **context window** (pinakamataas na bilang ng token na kaya nitong makita). Ang mga pangmatagalang chat ay nag-iipon ng mga mensahe at tool result; kapag masikip na ang window, ang OpenClaw ay
**nagko-compact** ng mas lumang history upang manatili sa loob ng mga limitasyon.

## Ano ang compaction

Ang compaction ay **nagsa-summarize ng mas lumang usapan** sa isang compact na summary entry at pinananatiling buo ang mga kamakailang mensahe. Ang summary ay iniimbak sa session history, kaya ang mga susunod na request ay gumagamit ng:

- Ang compaction summary
- Mga kamakailang mensahe pagkatapos ng compaction point

Ang compaction ay **nagpe-persist** sa JSONL history ng session.

## Konpigurasyon

Tingnan ang [Compaction config & modes](/concepts/compaction) para sa mga setting ng `agents.defaults.compaction`.

## Auto-compaction (default na naka-on)

Kapag ang isang session ay papalapit o lumalagpas sa context window ng model, tina-trigger ng OpenClaw ang auto-compaction at maaaring ulitin ang orihinal na request gamit ang compacted na context.

Makikita mo ang:

- `🧹 Auto-compaction complete` sa verbose mode
- `/status` na nagpapakita ng `🧹 Compactions: <count>`

Bago ang compaction, maaaring magpatakbo ang OpenClaw ng isang **silent memory flush** turn upang mag-imbak ng
durable na mga tala sa disk. Tingnan ang [Memory](/concepts/memory) para sa mga detalye at config.

## Manual na compaction

Gamitin ang `/compact` (opsyonal na may mga tagubilin) upang pilitin ang isang compaction pass:

```
/compact Focus on decisions and open questions
```

## Pinagmulan ng context window

Ang context window ay partikular sa modelo. Ginagamit ng OpenClaw ang model definition mula sa naka-configure na provider catalog upang matukoy ang mga limitasyon.

## Compaction vs pruning

- **Compaction**: nagsa-summarize at **nagpe-persist** sa JSONL.
- **Session pruning**: nagta-trim lang ng mga lumang **tool result**, **in-memory**, kada request.

Tingnan ang [/concepts/session-pruning](/concepts/session-pruning) para sa mga detalye ng pruning.

## Mga tip

- Gamitin ang `/compact` kapag pakiramdam ay luma na ang mga session o namamaga ang context.
- Ang malalaking output ng tool ay na-truncate na; makakatulong pa ang pruning para mabawasan ang naiipong tool-result.
- Kung kailangan mo ng panibagong simula, ang `/new` o `/reset` ay nagsisimula ng bagong session id.
