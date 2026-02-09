---
summary: "Context: kung ano ang nakikita ng model, paano ito binubuo, at paano ito siyasatin"
read_when:
  - Gusto mong maunawaan kung ano ang ibig sabihin ng “context” sa OpenClaw
  - Nagde-debug ka kung bakit may “alam” ang model tungkol sa isang bagay (o nakalimutan ito)
  - Gusto mong bawasan ang context overhead (/context, /status, /compact)
title: "Context"
---

# Context

Ang “Context” ay **lahat ng ipinapadala ng OpenClaw sa modelo para sa isang run**. Ito ay nalilimitahan ng **context window** ng modelo (token limit).

Pang-baguhan na mental model:

- **System prompt** (binuo ng OpenClaw): mga patakaran, mga tool, listahan ng Skills, oras/runtime, at mga na-inject na workspace file.
- **Kasaysayan ng usapan**: ang iyong mga mensahe + mga mensahe ng assistant para sa session na ito.
- **Mga tawag sa tool/resulta + mga attachment**: output ng command, pagbasa ng file, mga larawan/audio, atbp.

Ang context ay _hindi kapareho_ ng “memory”: ang memory ay maaaring i-store sa disk at i-load muli sa hinaharap; ang context ay kung ano ang nasa loob ng kasalukuyang window ng model.

## Mabilis na pagsisimula (suriin ang context)

- `/status` → mabilis na “gaano kapuno ang aking window?” na view + mga setting ng session.
- `/context list` → kung ano ang na-inject + tinatayang laki (bawat file + kabuuan).
- `/context detail` → mas detalyadong breakdown: laki bawat file, laki ng schema bawat tool, laki ng entry bawat skill, at laki ng system prompt.
- `/usage tokens` → magdagdag ng per-reply usage footer sa mga normal na sagot.
- `/compact` → ibuod ang mas lumang kasaysayan sa isang compact na entry para magbakante ng espasyo sa window.

Tingnan din: [Slash commands](/tools/slash-commands), [Token use & costs](/reference/token-use), [Compaction](/concepts/compaction).

## Halimbawang output

Nag-iiba ang mga value depende sa model, provider, patakaran ng tool, at kung ano ang nasa iyong workspace.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## Ano ang binibilang sa context window

Lahat ng natatanggap ng model ay binibilang, kabilang ang:

- System prompt (lahat ng seksyon).
- Kasaysayan ng usapan.
- Mga tawag sa tool + mga resulta ng tool.
- Mga attachment/transcript (mga larawan/audio/file).
- Mga buod ng compaction at mga artifact ng pruning.
- Mga “wrapper” ng provider o mga nakatagong header (hindi nakikita, pero binibilang pa rin).

## Paano binubuo ng OpenClaw ang system prompt

Ang system prompt ay **pagmamay-ari ng OpenClaw** at muling binubuo sa bawat run. Kasama rito ang:

- Listahan ng tool + maiikling paglalarawan.
- Listahan ng Skills (metadata lang; tingnan sa ibaba).
- Lokasyon ng workspace.
- Oras (UTC + na-convert na oras ng user kung naka-configure).
- Runtime metadata (host/OS/model/thinking).
- Mga na-inject na workspace bootstrap file sa ilalim ng **Project Context**.

Buong breakdown: [System Prompt](/concepts/system-prompt).

## Mga na-inject na workspace file (Project Context)

Bilang default, nag-i-inject ang OpenClaw ng isang nakapirming set ng workspace file (kung mayroon):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (unang run lang)

Ang malalaking file ay tina-truncate kada file gamit ang `agents.defaults.bootstrapMaxChars` (default na `20000` chars). `/context` ay nagpapakita ng **raw vs injected** na laki at kung may nangyaring truncation.

## Skills: ano ang na-inject vs nilo-load kapag kailangan

Kasama sa system prompt ang isang compact na **skills list** (pangalan + paglalarawan + lokasyon). May tunay na overhead ang listahang ito.

Ang mga instruction ng skill ay _hindi_ kasama bilang default. Inaasahang `babasa` ang modelo ng `SKILL.md` ng skill **kung kinakailangan lamang**.

## Tools: may dalawang gastos

Nakaaapekto ang mga tool sa context sa dalawang paraan:

1. **Teksto ng listahan ng tool** sa system prompt (ang nakikita mo bilang “Tooling”).
2. **Mga tool schema** (JSON). Ipinapadala ang mga ito sa modelo upang makatawag ito ng mga tool. Bilang sila sa context kahit hindi mo sila nakikita bilang plain text.

Ibinibigay ng `/context detail` ang breakdown ng pinakamalalaking schema ng tool para makita mo kung alin ang nangingibabaw.

## Mga command, direktiba, at “inline shortcuts”

Ang mga slash command ay hinahawakan ng Gateway. May ilang magkakaibang behavior:

- **Standalone commands**: isang mensahe na `/...` lang ay tatakbo bilang command.
- **Mga direktiba**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` ay inaalis bago makita ng model ang mensahe.
  - Ang mga mensaheng puro direktiba ay nagpapanatili ng mga setting ng session.
  - Ang mga inline na direktiba sa isang normal na mensahe ay kumikilos bilang per-message na mga hint.
- **Inline shortcuts** (allowlisted senders lang): ilang `/...` na token sa loob ng normal na mensahe ay maaaring tumakbo kaagad (halimbawa: “hey /status”), at inaalis bago makita ng model ang natitirang teksto.

Mga detalye: [Slash commands](/tools/slash-commands).

## Mga session, compaction, at pruning (ano ang nananatili)

Kung ano ang nananatili sa bawat mensahe ay nakadepende sa mekanismo:

- **Normal na history** ay nananatili sa transcript ng session hanggang ma-compact/ma-prune ayon sa patakaran.
- **Compaction** ay nagpapanatili ng isang buod sa transcript at pinananatiling buo ang mga kamakailang mensahe.
- **Pruning** ay nag-aalis ng mga lumang resulta ng tool mula sa _in-memory_ prompt para sa isang run, ngunit hindi nirerewrite ang transcript.

Docs: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

## Ano ang talagang iniuulat ng `/context`

Mas pinipili ng `/context` ang pinakabagong **run-built** na ulat ng system prompt kapag available:

- `System prompt (run)` = kinuhang data mula sa huling embedded (may kakayahang tool) na run at pinanatili sa session store.
- `System prompt (estimate)` = kinukuwenta on the fly kapag walang run report (o kapag tumatakbo sa pamamagitan ng CLI backend na hindi gumagawa ng ulat).

Sa alinmang paraan, nag-uulat ito ng mga laki at nangungunang contributor; **hindi** nito idinidump ang buong system prompt o ang mga schema ng tool.
