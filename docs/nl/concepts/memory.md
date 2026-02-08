---
summary: "Hoe OpenClaw-geheugen werkt (werkruimtebestanden + automatische geheugenflush)"
read_when:
  - Je wilt de geheugenbestandsindeling en workflow
  - Je wilt de automatische pre-compactie geheugenflush afstellen
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:03Z
---

# Geheugen

OpenClaw-geheugen is **platte Markdown in de agentwerkruimte**. De bestanden zijn de
bron van waarheid; het model “onthoudt” alleen wat naar schijf wordt geschreven.

Geheugenz oektools worden geleverd door de actieve geheugenplugin (standaard:
`memory-core`). Schakel geheugenplugins uit met `plugins.slots.memory = "none"`.

## Geheugenbestanden (Markdown)

De standaard werkruimte-indeling gebruikt twee geheugenlagen:

- `memory/YYYY-MM-DD.md`
  - Daglog (alleen toevoegen).
  - Leest vandaag + gisteren bij sessiestart.
- `MEMORY.md` (optioneel)
  - Gecureerd langetermijngeheugen.
  - **Alleen laden in de hoofd-, privésessie** (nooit in groepscontexten).

Deze bestanden staan onder de werkruimte (`agents.defaults.workspace`, standaard
`~/.openclaw/workspace`). Zie [Agent workspace](/concepts/agent-workspace) voor de volledige indeling.

## Wanneer geheugen schrijven

- Beslissingen, voorkeuren en duurzame feiten gaan naar `MEMORY.md`.
- Dagelijkse notities en lopende context gaan naar `memory/YYYY-MM-DD.md`.
- Als iemand zegt “onthoud dit”, schrijf het op (houd het niet in RAM).
- Dit gebied is nog in ontwikkeling. Het helpt om het model eraan te herinneren om herinneringen op te slaan; het weet wat het moet doen.
- Als je wilt dat iets blijft hangen, **vraag de bot om het** in het geheugen te schrijven.

## Automatische geheugenflush (pre-compactie-ping)

Wanneer een sessie **dicht bij auto-compactie** is, triggert OpenClaw een **stille,
agentische beurt** die het model eraan herinnert om duurzaam geheugen te schrijven **vóórdat**
de context wordt gecompacteerd. De standaardprompts zeggen expliciet dat het model _mag antwoorden_,
maar meestal is `NO_REPLY` de juiste reactie zodat de gebruiker deze beurt nooit ziet.

Dit wordt aangestuurd door `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Details:

- **Zachte drempel**: de flush triggert wanneer de geschatte sessietokens
  `contextWindow - reserveTokensFloor - softThresholdTokens` overschrijden.
- **Stil** standaard: prompts bevatten `NO_REPLY` zodat er niets wordt afgeleverd.
- **Twee prompts**: een gebruikersprompt plus een systeemprompt voegen de herinnering toe.
- **Eén flush per compactiecyclus** (bijgehouden in `sessions.json`).
- **Werkruimte moet schrijfbaar zijn**: als de sessie gesandboxed draait met
  `workspaceAccess: "ro"` of `"none"`, wordt de flush overgeslagen.

Voor de volledige compactie-levenscyclus, zie
[Session management + compaction](/reference/session-management-compaction).

## Vectorgeheugenz oeken

OpenClaw kan een kleine vectorindex bouwen over `MEMORY.md` en `memory/*.md` zodat
semantische queries gerelateerde notities kunnen vinden, zelfs wanneer de formulering verschilt.

Standaardinstellingen:

- Standaard ingeschakeld.
- Houdt geheugenbestanden in de gaten voor wijzigingen (gedebounced).
- Gebruikt standaard externe embeddings. Als `memorySearch.provider` niet is ingesteld, selecteert OpenClaw automatisch:
  1. `local` als een `memorySearch.local.modelPath` is geconfigureerd en het bestand bestaat.
  2. `openai` als een OpenAI-sleutel kan worden gevonden.
  3. `gemini` als een Gemini-sleutel kan worden gevonden.
  4. `voyage` als een Voyage-sleutel kan worden gevonden.
  5. Anders blijft geheugenzoeken uitgeschakeld totdat het is geconfigureerd.
- Lokale modus gebruikt node-llama-cpp en kan `pnpm approve-builds` vereisen.
- Gebruikt sqlite-vec (wanneer beschikbaar) om vectorzoeken binnen SQLite te versnellen.

Externe embeddings **vereisen** een API-sleutel voor de embeddingprovider. OpenClaw
lost sleutels op via auth-profielen, `models.providers.*.apiKey` of omgevings-
variabelen. Codex OAuth dekt alleen chat/completions en voldoet **niet** voor
embeddings voor geheugenzoeken. Voor Gemini, gebruik `GEMINI_API_KEY` of
`models.providers.google.apiKey`. Voor Voyage, gebruik `VOYAGE_API_KEY` of
`models.providers.voyage.apiKey`. Bij gebruik van een aangepaste OpenAI-compatibele endpoint,
stel `memorySearch.remote.apiKey` in (en optioneel `memorySearch.remote.headers`).

### QMD-backend (experimenteel)

Stel `memory.backend = "qmd"` in om de ingebouwde SQLite-indexer te vervangen door
[QMD](https://github.com/tobi/qmd): een local-first zoek-sidecar die
BM25 + vectoren + reranking combineert. Markdown blijft de bron van waarheid; OpenClaw
roept QMD aan voor retrieval. Belangrijke punten:

**Vereisten**

- Standaard uitgeschakeld. Opt-in per config (`memory.backend = "qmd"`).
- Installeer de QMD CLI apart (`bun install -g https://github.com/tobi/qmd` of download
  een release) en zorg dat het `qmd`-binary op de `PATH` van de gateway staat.
- QMD heeft een SQLite-build nodig die extensies toestaat (`brew install sqlite` op
  macOS).
- QMD draait volledig lokaal via Bun + `node-llama-cpp` en downloadt GGUF-
  modellen automatisch van HuggingFace bij eerste gebruik (geen aparte Ollama-daemon vereist).
- De gateway draait QMD in een zelfvoorzienende XDG-home onder
  `~/.openclaw/agents/<agentId>/qmd/` door `XDG_CONFIG_HOME` en
  `XDG_CACHE_HOME` in te stellen.
- OS-ondersteuning: macOS en Linux werken out-of-the-box zodra Bun + SQLite zijn
  geïnstalleerd. Windows wordt het best ondersteund via WSL2.

**Hoe de sidecar draait**

- De gateway schrijft een zelfvoorzienende QMD-home onder
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + sqlite-DB).
- Collecties worden aangemaakt via `qmd collection add` vanuit `memory.qmd.paths`
  (plus standaard werkruimtegeheugenbestanden), daarna draaien `qmd update` + `qmd embed`
  bij boot en op een configureerbaar interval (`memory.qmd.update.interval`,
  standaard 5 min).
- De boot-verversing draait nu standaard op de achtergrond zodat de chatstart niet
  wordt geblokkeerd; stel `memory.qmd.update.waitForBootSync = true` in om het eerdere
  blokkerende gedrag te behouden.
- Zoekopdrachten lopen via `qmd query --json`. Als QMD faalt of het binary ontbreekt,
  valt OpenClaw automatisch terug op de ingebouwde SQLite-manager zodat geheugentools
  blijven werken.
- OpenClaw stelt momenteel geen QMD embed batch-size tuning bloot; batchgedrag wordt
  door QMD zelf bepaald.
- **Eerste zoekopdracht kan traag zijn**: QMD kan lokale GGUF-modellen (reranker/query-
  expansie) downloaden bij de eerste `qmd query` run.
  - OpenClaw stelt `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automatisch in wanneer het QMD draait.
  - Als je modellen handmatig vooraf wilt downloaden (en dezelfde index wilt opwarmen
    die OpenClaw gebruikt), voer een eenmalige query uit met de XDG-dirs van de agent.

    De QMD-status van OpenClaw staat onder je **state-dir** (standaard `~/.openclaw`).
    Je kunt `qmd` naar exact dezelfde index laten wijzen door dezelfde XDG-vars
    te exporteren die OpenClaw gebruikt:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Config-oppervlak (`memory.qmd.*`)**

- `command` (standaard `qmd`): overschrijft het pad naar het uitvoerbare bestand.
- `includeDefaultMemory` (standaard `true`): auto-indexeer `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: voeg extra mappen/bestanden toe (`path`, optioneel `pattern`, optioneel
  stabiel `name`).
- `sessions`: opt-in voor sessie-JSONL-indexering (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: regelt verversingscadans en onderhoudsuitvoering:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: begrenst recall-payload (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: hetzelfde schema als [`session.sendPolicy`](/gateway/configuration#session).
  Standaard is alleen DM (`deny` alles, `allow` directe chats); versoepel dit om QMD-
  treffers in groepen/kanalen te tonen.
- Snippets die buiten de werkruimte zijn gesourced verschijnen als
  `qmd/<collection>/<relative-path>` in `memory_search`-resultaten; `memory_get`
  begrijpt die prefix en leest uit de geconfigureerde QMD-collectiewortel.
- Wanneer `memory.qmd.sessions.enabled = true`, exporteert OpenClaw opgeschoonde sessie-
  transcripties (Gebruiker/Assistent-beurten) naar een aparte QMD-collectie onder
  `~/.openclaw/agents/<id>/qmd/sessions/`, zodat `memory_search` recente
  gesprekken kan ophalen zonder de ingebouwde SQLite-index aan te raken.
- `memory_search`-snippets bevatten nu een `Source: <path#line>`-footer wanneer
  `memory.citations` `auto`/`on` is; stel `memory.citations = "off"` in om
  de padmetadata intern te houden (de agent ontvangt het pad nog steeds voor
  `memory_get`, maar de snippettekst laat de footer weg en de systeemprompt
  waarschuwt de agent om het niet te citeren).

**Voorbeeld**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Citaten & fallback**

- `memory.citations` geldt ongeacht backend (`auto`/`on`/`off`).
- Wanneer `qmd` draait, taggen we `status().backend = "qmd"` zodat diagnostiek toont welke
  engine de resultaten leverde. Als het QMD-subproces stopt of JSON-uitvoer niet kan
  worden geparsed, logt de zoekmanager een waarschuwing en retourneert de ingebouwde provider
  (bestaande Markdown-embeddings) totdat QMD herstelt.

### Aanvullende geheugenpaden

Als je Markdown-bestanden buiten de standaard werkruimte-indeling wilt indexeren, voeg
expliciete paden toe:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Notities:

- Paden kunnen absoluut zijn of werkruimte-relatief.
- Mappen worden recursief gescand op `.md`-bestanden.
- Alleen Markdown-bestanden worden geïndexeerd.
- Symlinks worden genegeerd (bestanden of mappen).

### Gemini-embeddings (native)

Stel de provider in op `gemini` om de Gemini-embeddings-API direct te gebruiken:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notities:

- `remote.baseUrl` is optioneel (standaard de Gemini API-basis-URL).
- `remote.headers` laat je extra headers toevoegen indien nodig.
- Standaardmodel: `gemini-embedding-001`.

Als je een **aangepaste OpenAI-compatibele endpoint** (OpenRouter, vLLM of een proxy)
wilt gebruiken, kun je de `remote`-configuratie met de OpenAI-provider gebruiken:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Als je geen API-sleutel wilt instellen, gebruik `memorySearch.provider = "local"` of stel
`memorySearch.fallback = "none"` in.

Fallbacks:

- `memorySearch.fallback` kan `openai`, `gemini`, `local` of `none` zijn.
- De fallbackprovider wordt alleen gebruikt wanneer de primaire embeddingprovider faalt.

Batch-indexering (OpenAI + Gemini):

- Standaard ingeschakeld voor OpenAI- en Gemini-embeddings. Stel `agents.defaults.memorySearch.remote.batch.enabled = false` in om uit te schakelen.
- Standaardgedrag wacht op batchvoltooiing; stel `remote.batch.wait`, `remote.batch.pollIntervalMs` en `remote.batch.timeoutMinutes` af indien nodig.
- Stel `remote.batch.concurrency` in om te bepalen hoeveel batchjobs we parallel indienen (standaard: 2).
- Batchmodus is van toepassing wanneer `memorySearch.provider = "openai"` of `"gemini"` en gebruikt de bijbehorende API-sleutel.
- Gemini-batchjobs gebruiken het asynchrone embeddings-batchendpoint en vereisen beschikbaarheid van de Gemini Batch API.

Waarom OpenAI-batch snel + goedkoop is:

- Voor grote backfills is OpenAI doorgaans de snelste optie die we ondersteunen, omdat we veel embedding-aanvragen in één batchjob kunnen indienen en OpenAI ze asynchroon kan verwerken.
- OpenAI biedt gereduceerde prijzen voor Batch API-workloads, waardoor grote indexeer-runs meestal goedkoper zijn dan dezelfde aanvragen synchroon te verzenden.
- Zie de OpenAI Batch API-documentatie en prijzen voor details:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Config-voorbeeld:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Tools:

- `memory_search` — retourneert snippets met bestand + regelbereiken.
- `memory_get` — lees geheugenbestandsinhoud op pad.

Lokale modus:

- Stel `agents.defaults.memorySearch.provider = "local"` in.
- Geef `agents.defaults.memorySearch.local.modelPath` op (GGUF of `hf:`-URI).
- Optioneel: stel `agents.defaults.memorySearch.fallback = "none"` in om externe fallback te vermijden.

### Hoe de geheugentools werken

- `memory_search` doorzoekt semantisch Markdown-chunks (~400 tokens doel, 80-token overlap) uit `MEMORY.md` + `memory/**/*.md`. Het retourneert snippettekst (begrensd ~700 tekens), bestandspad, regelbereik, score, provider/model en of we zijn teruggevallen van lokale → externe embeddings. Er wordt geen volledige bestandsinhoud geretourneerd.
- `memory_get` leest een specifiek geheugen-Markdownbestand (werkruimte-relatief), optioneel vanaf een startregel en voor N regels. Paden buiten `MEMORY.md` / `memory/` worden geweigerd.
- Beide tools zijn alleen ingeschakeld wanneer `memorySearch.enabled` waar is voor de agent.

### Wat wordt geïndexeerd (en wanneer)

- Bestandstype: alleen Markdown (`MEMORY.md`, `memory/**/*.md`).
- Indexopslag: per agent SQLite op `~/.openclaw/memory/<agentId>.sqlite` (configureerbaar via `agents.defaults.memorySearch.store.path`, ondersteunt `{agentId}`-token).
- Actualiteit: watcher op `MEMORY.md` + `memory/` markeert de index als vervuild (debounce 1,5 s). Sync wordt gepland bij sessiestart, bij zoeken of op een interval en draait asynchroon. Sessietranscripties gebruiken delta-drempels om achtergrond-sync te triggeren.
- Herindexeer-triggers: de index slaat de embedding **provider/model + endpoint-vingerafdruk + chunking-parameters** op. Als een daarvan verandert, reset en herindexeert OpenClaw automatisch de volledige store.

### Hybride zoeken (BM25 + vector)

Wanneer ingeschakeld combineert OpenClaw:

- **Vector-similariteit** (semantische match, formulering kan verschillen)
- **BM25-sleutelwoordrelevantie** (exacte tokens zoals ID’s, omgevingsvariabelen, codesymbolen)

Als full-text zoeken niet beschikbaar is op je platform, valt OpenClaw terug op alleen vectorzoeken.

#### Waarom hybride?

Vectorzoeken is geweldig voor “dit betekent hetzelfde”:

- “Mac Studio gateway host” vs “de machine waarop de gateway draait”
- “debounce file updates” vs “indexeren bij elke write vermijden”

Maar het kan zwak zijn bij exacte, hoog-signaal tokens:

- ID’s (`a828e60`, `b3b9895a…`)
- codesymbolen (`memorySearch.query.hybrid`)
- foutstrings (“sqlite-vec unavailable”)

BM25 (full-text) is het tegenovergestelde: sterk bij exacte tokens, zwakker bij parafrasen.
Hybride zoeken is het pragmatische midden: **gebruik beide retrieval-signalen** zodat je
goede resultaten krijgt voor zowel “natuurlijke taal”-queries als “speld in een hooiberg”-queries.

#### Hoe we resultaten samenvoegen (het huidige ontwerp)

Implementatieschets:

1. Haal een kandidatenpool op van beide kanten:

- **Vector**: top `maxResults * candidateMultiplier` op cosine-similariteit.
- **BM25**: top `maxResults * candidateMultiplier` op FTS5 BM25-rang (lager is beter).

2. Converteer BM25-rang naar een 0..1-achtige score:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Combineer kandidaten per chunk-id en bereken een gewogen score:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notities:

- `vectorWeight` + `textWeight` wordt genormaliseerd naar 1,0 in config-resolutie, zodat gewichten zich als percentages gedragen.
- Als embeddings niet beschikbaar zijn (of de provider een nulvector retourneert), draaien we BM25 alsnog en retourneren we sleutelwoordmatches.
- Als FTS5 niet kan worden aangemaakt, behouden we alleen vectorzoeken (geen harde fout).

Dit is niet “IR-theorie-perfect”, maar het is eenvoudig, snel en verbetert doorgaans recall/precisie op echte notities.
Als we later geavanceerder willen worden, zijn gebruikelijke volgende stappen Reciprocal Rank Fusion (RRF) of score-normalisatie
(min/max of z-score) vóór het mengen.

Config:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Embedding-cache

OpenClaw kan **chunk-embeddings** in SQLite cachen zodat herindexering en frequente updates (vooral sessietranscripties) ongewijzigde tekst niet opnieuw embedden.

Config:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Sessie-geheugenz oeken (experimenteel)

Je kunt optioneel **sessietranscripties** indexeren en ze beschikbaar maken via `memory_search`.
Dit staat achter een experimentele vlag.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Notities:

- Sessie-indexering is **opt-in** (standaard uit).
- Sessie-updates worden gedebounced en **asynchroon geïndexeerd** zodra ze delta-drempels overschrijden (best-effort).
- `memory_search` blokkeert nooit op indexering; resultaten kunnen licht verouderd zijn totdat de achtergrond-sync is voltooid.
- Resultaten bevatten nog steeds alleen snippets; `memory_get` blijft beperkt tot geheugenbestanden.
- Sessie-indexering is per agent geïsoleerd (alleen de sessielogs van die agent worden geïndexeerd).
- Sessielogs staan op schijf (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Elk proces/gebruiker met bestandssysteemtoegang kan ze lezen, dus beschouw schijftoegang als de vertrouwensgrens. Voor strengere isolatie, draai agents onder afzonderlijke OS-gebruikers of hosts.

Delta-drempels (standaardwaarden getoond):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite-vectorversnelling (sqlite-vec)

Wanneer de sqlite-vec-extensie beschikbaar is, slaat OpenClaw embeddings op in een
SQLite-virtuele tabel (`vec0`) en voert vectorafstandqueries uit in de
database. Dit houdt zoeken snel zonder elke embedding in JS te laden.

Configuratie (optioneel):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Notities:

- `enabled` staat standaard op true; wanneer uitgeschakeld, valt zoeken terug op in-proces
  cosine-similariteit over opgeslagen embeddings.
- Als de sqlite-vec-extensie ontbreekt of niet kan worden geladen, logt OpenClaw de
  fout en gaat door met de JS-fallback (geen vectortabel).
- `extensionPath` overschrijft het gebundelde sqlite-vec-pad (handig voor aangepaste builds
  of niet-standaard installatielocaties).

### Automatische download van lokale embeddings

- Standaard lokaal embeddingmodel: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- Wanneer `memorySearch.provider = "local"`, resolveert `node-llama-cpp` `modelPath`; als de GGUF ontbreekt **downloadt het automatisch** naar de cache (of `local.modelCacheDir` indien ingesteld), en laadt het daarna. Downloads worden hervat bij retry.
- Vereiste voor native build: voer `pnpm approve-builds` uit, kies `node-llama-cpp`, en daarna `pnpm rebuild node-llama-cpp`.
- Fallback: als lokale setup faalt en `memorySearch.fallback = "openai"`, schakelen we automatisch over op externe embeddings (`openai/text-embedding-3-small` tenzij overschreven) en registreren we de reden.

### Voorbeeld aangepaste OpenAI-compatibele endpoint

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Notities:

- `remote.*` heeft voorrang op `models.providers.openai.*`.
- `remote.headers` voegt samen met OpenAI-headers; extern wint bij sleutelconflicten. Laat `remote.headers` weg om de OpenAI-standaard te gebruiken.
