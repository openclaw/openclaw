---
summary: "Sådan fungerer OpenClaw-hukommelse (arbejdsområdefiler + automatisk hukommelses-flush)"
read_when:
  - Du vil kende hukommelsesfilernes layout og workflow
  - Du vil justere den automatiske pre-kompakterings-hukommelses-flush
---

# Memory

OpenClaw hukommelse er **almindelig Markdown i agenten arbejdsområdet**. Filerne er
kilden til sandheden; modellen kun "husker", hvad der bliver skrevet til disk.

Hukommelse søgeværktøjer leveres af den aktive hukommelse plugin (standard:
`memory-core`). Deaktivér hukommelsesplugins med `plugins.slots.memory = "none"`.

## Hukommelsesfiler (Markdown)

Standardlayoutet for arbejdsområdet bruger to hukommelseslag:

- `memory/YYYY-MM-DD.md`
  - Daglig log (kun append).
  - Læs i dag + i går ved sessionstart.
- `MEMORY.md` (valgfri)
  - Kurateret langtids­hukommelse.
  - **Indlæses kun i den primære, private session** (aldrig i gruppesammenhænge).

Disse filer lever under arbejdsområdet (`agents.defaults.workspace`, standard
`~/.openclaw/workspace`). Se [Agent arbejdsområde](/concepts/agent-workspace) for det fulde layout.

## Hvornår skal der skrives hukommelse

- Beslutninger, præferencer og varige fakta går i `MEMORY.md`.
- Daglige noter og løbende kontekst går i `memory/YYYY-MM-DD.md`.
- Hvis nogen siger “husk dette”, så skriv det ned (behold det ikke i RAM).
- Dette område er stadig under udvikling. Det hjælper til at minde modellen til at gemme minder; det vil vide, hvad de skal gøre.
- Hvis du vil have noget til at hænge ved, **bed botten om at skrive det** i hukommelsen.

## Automatisk hukommelses-flush (pre-kompakterings-ping)

Når en session er **tæt på automatisk komprimering**, udløser OpenClaw en **tavs,
agentisk drejning** der minder modellen om at skrive holdbar hukommelse \*\* før\*\*
konteksten er komprimeret. Standard beder udtrykkeligt sige modellen _may reply_,
men normalt `NO_REPLY` er det korrekte svar, så brugeren aldrig ser denne tur.

Dette styres af `agents.defaults.compaction.memoryFlush`:

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

Detaljer:

- **Blød tærskel**: flush udløses, når sessionens token-estimat krydser
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Tavs** som standard: prompter inkluderer `NO_REPLY`, så intet leveres.
- **To prompter**: en brugerprompt plus en systemprompt tilføjer påmindelsen.
- **Én flush pr. kompakteringscyklus** (sporet i `sessions.json`).
- **Arbejdsområdet skal være skrivbart**: hvis sessionen kører sandboxed med
  `workspaceAccess: "ro"` eller `"none"`, springes flush over.

For den fulde kompakteringslivscyklus, se
[Session management + compaction](/reference/session-management-compaction).

## Vektor-hukommelsessøgning

OpenClaw kan opbygge et lille vektorindeks over `MEMORY.md` og `memory/*.md`, så
semantiske forespørgsler kan finde relaterede noter, selv når ordlyden er forskellig.

Standardindstillinger:

- Aktiveret som standard.
- Overvåger hukommelsesfiler for ændringer (debounced).
- Bruger fjernindlejringer som standard. Hvis `memorySearch.provider` ikke er angivet, OpenClaw auto-selects:
  1. `local` hvis en `memorySearch.local.modelPath` er konfigureret, og filen findes.
  2. `openai` hvis en OpenAI-nøgle kan findes.
  3. `gemini` hvis en Gemini-nøgle kan findes.
  4. `voyage` hvis en Voyage-nøgle kan findes.
  5. Ellers forbliver hukommelsessøgning deaktiveret, indtil den konfigureres.
- Lokal tilstand bruger node-llama-cpp og kan kræve `pnpm approve-builds`.
- Bruger sqlite-vec (når tilgængelig) til at accelerere vektorsøgning inde i SQLite.

Fjernindlejringer **kræve** en API-nøgle til den indlejrede udbyder. OpenClaw
løser nøgler fra auth profiler, `models.providers.*.apiKey`, eller miljø
variabler. Codex OAuth dækker kun chat/komplettering og opfylder **ikke**
indlejringer til hukommelsessøgning. For Gemini, brug `GEMINI_API_KEY` eller
`models.providers.google.apiKey`. For Voyage, brug `VOYAGE_API_KEY` eller
`models.providers.voyage.apiKey`. Når du bruger en brugerdefineret OpenAI-kompatibel endepunkt,
sæt `hukommelseSearch.remote.apiKey` (og valgfri `memorySearch.remote.headers`).

### QMD-backend (eksperimentel)

Angiv `hukommelse. ackend = "qmd"` for at bytte den indbyggede SQLite indexer for
[QMD](https://github.com/tobi/qmd): en lokal første søgning sidevogn, der kombinerer
BM25 + vektorer + reranking. Markdown forbliver kilden til sandheden; OpenClaw skaller
ud til QMD for at hente. Nøglepunkter:

**Forudsætninger**

- Deaktiveret som standard. Vælg i per-config (`memory.backend = "qmd"`).
- Installér QMD CLI separat (`bun install -g https://github.com/tobi/qmd` eller hent
  en release), og sørg for, at `qmd`-binæren er på gatewayens `PATH`.
- QMD kræver et SQLite-build, der tillader udvidelser (`brew install sqlite` på
  macOS).
- QMD kører fuldt lokalt via Bun + `node-llama-cpp` og downloader automatisk GGUF-
  modeller fra HuggingFace ved første brug (ingen separat Ollama-daemon kræves).
- Gatewayen kører QMD i et selvstændigt XDG-hjem under
  `~/.openclaw/agents/<agentId>/qmd/` ved at sætte `XDG_CONFIG_HOME` og
  `XDG_CACHE_HOME`.
- OS support: macOS og Linux arbejde ud af boksen når Bun + SQLite er
  installeret. Windows understøttes bedst via WSL2.

**Sådan kører sidecaren**

- Gatewayen skriver et selvstændigt QMD-hjem under
  `~/.openclaw/agents/<agentId>/qmd/` (konfiguration + cache + sqlite-DB).
- Samlinger oprettes via `qmd collection add` fra `memory.qmd.paths`
  (plus standardhukommelsesfiler i arbejdsområdet), derefter kører `qmd update` + `qmd embed`
  ved boot og på et konfigurerbart interval (`memory.qmd.update.interval`,
  standard 5 min).
- Boot-opdatering kører nu i baggrunden som standard, så chat-opstart ikke
  blokeres; sæt `memory.qmd.update.waitForBootSync = true` for at bevare den tidligere
  blokerende adfærd.
- Søgninger kører via `qmd forespørgsel --json`. Hvis QMD mislykkes, eller den binære mangler, falder
  OpenClaw automatisk tilbage til den indbyggede SQLite manager, så hukommelsesværktøjer
  bliver ved med at fungere.
- OpenClaw eksponerer ikke tuning af QMD’s embed batch-størrelse i dag; batch-
  adfærd styres af QMD selv.
- **Første søgning kan være langsom**: QMD kan downloade lokale GGUF-modeller
  (reranker/forespørgselsudvidelse) ved første `qmd query`-kørsel.
  - OpenClaw sætter `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automatisk, når den kører QMD.
  - Hvis du vil foruddownloade modeller manuelt (og varme det samme indeks, som
    OpenClaw bruger), så kør en engangsforespørgsel med agentens XDG-mapper.

    OpenClaws QMD-tilstand lever under din **state dir** (standard er `~/.openclaw`).
    Du kan pege `qmd` på nøjagtig samme indeks ved at eksportere de samme XDG vars
    OpenClaw bruger:

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

**Konfigurationsflade (`memory.qmd.*`)**

- `command` (standard `qmd`): tilsidesæt stien til eksekverbar.
- `includeDefaultMemory` (standard `true`): auto-indeksér `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: tilføj ekstra mapper/filer (`path`, valgfri `pattern`, valgfri
  stabil `name`).
- `sessions`: tilmeld session JSONL-indeksering (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: styrer opdateringskadence og vedligeholdelseskørsel:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: begræns recall-payload (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: samme skema som [`session.sendPolicy`](/gateway/configuration#session).
  Standard er kun DM-only (`deny` all, `allow` direkte chats); løsn det til overflade QMD
  hits i grupper/kanaler.
- Snippets hentet uden for arbejdsområdet vises som
  `qmd/<collection>/<relative-path>` i `memory_search`-resultater; `memory_get`
  forstår dette præfiks og læser fra den konfigurerede QMD-samlingsrod.
- Når `memory.qmd.sessions.enabled = true`, eksporterer OpenClaw saniterede session-
  transskriptioner (User/Assistant-ture) til en dedikeret QMD-samling under
  `~/.openclaw/agents/<id>/qmd/sessions/`, så `memory_search` kan genkalde nylige
  samtaler uden at røre det indbyggede SQLite-indeks.
- `memory_search`-snippets inkluderer nu en `Source: <path#line>`-footer, når
  `memory.citations` er `auto`/`on`; sæt `memory.citations = "off"` for at holde
  stimetadata interne (agenten modtager stadig stien til
  `memory_get`, men snippet-teksten udelader footeren, og systemprompten
  advarer agenten mod at citere den).

**Eksempel**

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

**Citationer & fallback**

- `memory.citations` gælder uanset backend (`auto`/`on`/`off`).
- Når `qmd` kører, tagger vi `status().backend = "qmd"` så diagnostik viser, hvilken
  motor der tjente resultaterne. Hvis QMD delprocessen afslutter eller JSON output ikke kan
  parseres, Søg manager logger en advarsel og returnerer den indbyggede udbyder
  (eksisterende Markdown embeddings), indtil QMD gendannes.

### Yderligere hukommelsesstier

Hvis du vil indeksere Markdown-filer uden for standardlayoutet for arbejdsområdet,
tilføj eksplicitte stier:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Noter:

- Stier kan være absolutte eller relative til arbejdsområdet.
- Mapper scannes rekursivt for `.md`-filer.
- Kun Markdown-filer indekseres.
- Symlinks ignoreres (filer eller mapper).

### Gemini-embeddings (native)

Sæt udbyderen til `gemini` for at bruge Gemini-embeddings-API’et direkte:

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

Noter:

- `remote.baseUrl` er valgfri (standard er Gemini API-base-URL’en).
- `remote.headers` lader dig tilføje ekstra headers efter behov.
- Standardmodel: `gemini-embedding-001`.

Hvis du vil bruge et **brugerdefineret OpenAI-kompatibelt endpoint** (OpenRouter, vLLM eller en proxy),
kan du bruge `remote`-konfigurationen med OpenAI-udbyderen:

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

Hvis du ikke vil sætte en API-nøgle, brug `memorySearch.provider = "local"` eller sæt
`memorySearch.fallback = "none"`.

Fallbacks:

- `memorySearch.fallback` kan være `openai`, `gemini`, `local` eller `none`.
- Fallback-udbyderen bruges kun, når den primære embeddings-udbyder fejler.

Batch-indeksering (OpenAI + Gemini):

- Aktiveret som standard for OpenAI og Gemini embeddings. Sæt `agents.defaults.memorySearch.remote.batch.enabled = false` for at deaktivere.
- Standardadfærd venter på batch-fuldførelse; justér `remote.batch.wait`, `remote.batch.pollIntervalMs` og `remote.batch.timeoutMinutes` efter behov.
- Sæt `remote.batch.concurrency` for at styre, hvor mange batch-jobs vi indsender parallelt (standard: 2).
- Batch-tilstand gælder, når `memorySearch.provider = "openai"` eller `"gemini"`, og bruger den tilsvarende API-nøgle.
- Gemini batch-jobs bruger det asynkrone embeddings-batch-endpoint og kræver tilgængelighed af Gemini Batch API.

Hvorfor OpenAI-batch er hurtig + billig:

- Ved store backfills er OpenAI typisk den hurtigste mulighed, vi understøtter, fordi vi kan indsende mange embeddings-forespørgsler i ét batch-job og lade OpenAI behandle dem asynkront.
- OpenAI tilbyder rabatpriser for Batch API-arbejdsbelastninger, så store indekseringskørsler er ofte billigere end at sende de samme forespørgsler synkront.
- Se OpenAI Batch API-dokumentationen og priser for detaljer:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Konfigurationseksempel:

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

Værktøjer:

- `memory_search` — returnerer snippets med fil- og linjeintervaller.
- `memory_get` — læs indholdet af hukommelsesfilen efter sti.

Lokal tilstand:

- Sæt `agents.defaults.memorySearch.provider = "local"`.
- Angiv `agents.defaults.memorySearch.local.modelPath` (GGUF eller `hf:`-URI).
- Valgfrit: sæt `agents.defaults.memorySearch.fallback = "none"` for at undgå fjern-fallback.

### Sådan virker hukommelsesværktøjerne

- `memory_search` semantisk søgning Markdown chunks (~400 token target, 80-token overlap) fra `MEMORY.md` + `hukommelse/**/*.md`. Det returnerer snippet tekst (capped ~700 tegn), fil sti, linjeområde, score, udbyder / model, og om vi faldt tilbage fra lokale → fjern-indlejringer. Ingen fuld fil nyttelast er returneret.
- `memory_get` læser en bestemt hukommelse Markdown fil (arbejdsrums-relativ), eventuelt fra en startlinje og for N linjer. Stier uden for `MEMORY.md` / `hukommelse/` afvises.
- Begge værktøjer er kun aktiveret, når `memorySearch.enabled` evaluerer til true for agenten.

### Hvad der indekseres (og hvornår)

- Filtype: Kun Markdown (`MEMORY.md`, `memory/**/*.md`).
- Indekslagring: per-agent SQLite ved `~/.openclaw/memory/<agentId>.sqlite` (kan konfigureres via `agents.defaults.memorySearch.store.path`, understøtter `{agentId}`-token).
- Freshness: watcher på `MEMORY.md` + `hukommelse/` markerer indekset beskidt (debounce 1.5s). Synkronisering er skemalagt ved sessionsstart, ved søgning, eller på et interval og kører asynkront. Session transkriptioner bruger delta tærskler til at udløse baggrundssynkronisering.
- Reindex triggers: indekset gemmer indlejring **provider/model + endpoint fingeraftryk + chunking params**. Hvis nogen af disse ændringer, OpenClaw automatisk nulstiller og indekserer hele butikken.

### Hybrid søgning (BM25 + vektor)

Når aktiveret kombinerer OpenClaw:

- **Vektorsimilaritet** (semantisk match, ordlyd kan variere)
- **BM25-nøgleordsrelevans** (eksakte tokens som ID’er, env vars, kodesymboler)

Hvis fuldtekstsøgning ikke er tilgængelig på din platform, falder OpenClaw tilbage til vektor-kun-søgning.

#### Hvorfor hybrid?

Vektorsøgning er stærk til “det betyder det samme”:

- “Mac Studio gateway host” vs. “maskinen der kører gatewayen”
- “debounce file updates” vs. “undgå indeksering ved hvert write”

Men den kan være svag ved eksakte, høj-signals-tokens:

- ID’er (`a828e60`, `b3b9895a…`)
- kodesymboler (`memorySearch.query.hybrid`)
- fejlstrenge (“sqlite-vec unavailable”)

BM25 (fuldtekst) er det modsatte: stærk på eksakte tokens, svagere ved parafrases.
Hybrid søgning er den pragmatiske mellemrum: \*\* brug begge hentningssignaler \*\* så du får
gode resultater for både “naturligt sprog” forespørgsler og “nål i en høstakke” forespørgsler.

#### Sådan fletter vi resultater (det nuværende design)

Implementationsskitse:

1. Hent en kandidatpulje fra begge sider:

- **Vektor**: top `maxResults * candidateMultiplier` efter cosinus-similaritet.
- **BM25**: top `maxResults * candidateMultiplier` efter FTS5 BM25-rang (lavere er bedre).

2. Konvertér BM25-rang til en 0..1-agtig score:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Sammenslut kandidater efter chunk-id og beregn en vægtet score:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Noter:

- `vectorWeight` + `textWeight` normaliseres til 1,0 i konfigurationsopløsning, så vægte opfører sig som procenter.
- Hvis embeddings ikke er tilgængelige (eller udbyderen returnerer en nul-vektor), kører vi stadig BM25 og returnerer nøgleordsmatches.
- Hvis FTS5 ikke kan oprettes, beholder vi vektor-kun-søgning (ingen hård fejl).

Dette er ikke “IR-teori perfekt”, men det er enkelt, hurtigt, og tendens til at forbedre tilbagekaldelse/præcision på reelle noter.
Hvis vi ønsker at få fancier senere, fælles næste trin er Reciprocal Rank Fusion (RRF) eller score normalisering
(min/max eller z-score) før blanding.

Konfiguration:

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

OpenClaw kan cache **chunk-embeddings** i SQLite, så reindeksering og hyppige opdateringer
(især sessionstransskriptioner) ikke gen-embedd’er uændret tekst.

Konfiguration:

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

### Session-hukommelsessøgning (eksperimentel)

Du kan eventuelt indeksere **sessionstranskripter** og overfladebehandle dem via `memory_search`.
Dette er indrettet bag et eksperimentelt flag.

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

Noter:

- Sessionindeksering er **tilvalg** (slået fra som standard).
- Sessionopdateringer debounces og **indekseres asynkront**, når de krydser delta-tærskler (best-effort).
- `memory_search` blokerer aldrig på indeksering; resultater kan være en smule forældede, indtil baggrundssynk er færdig.
- Resultater inkluderer stadig kun snippets; `memory_get` forbliver begrænset til hukommelsesfiler.
- Sessionindeksering er isoleret pr. agent (kun den agents sessionslogs indekseres).
- Session logs live på disk (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Enhver proces/bruger med filsystemadgang kan læse dem, så behandle diskadgang som trustgrænsen. For strengere isolation, køre agenter under separate OS brugere eller værter.

Delta-tærskler (standarder vist):

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

### SQLite-vektoracceleration (sqlite-vec)

Når udvidelsen sqlite-vec er tilgængelig, gemmer OpenClaw indlejringer i en
SQLite virtuel tabel (`vec0`) og udfører forespørgsler om vektorafstand i
-databasen. Dette holder søgning hurtigt uden at indlæse hver indlejring i JS.

Konfiguration (valgfri):

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

Noter:

- `enabled` er true som standard; når deaktiveret falder søgning tilbage til
  in-process cosinus-similaritet over gemte embeddings.
- Hvis sqlite-vec-udvidelsen mangler eller fejler ved indlæsning, logger OpenClaw
  fejlen og fortsætter med JS-fallback (ingen vektortabel).
- `extensionPath` tilsidesætter den medfølgende sqlite-vec-sti (nyttigt til
  brugerdefinerede builds eller ikke-standard installationssteder).

### Automatisk download af lokale embeddings

- Standard lokal embeddings-model: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- Når `memorySearch.provider = "local"`, `node-llama-cpp` løser `modelPath`; hvis GGUF mangler det **auto-downloads** til cachen (eller `local.modelCacheDir` hvis angivet), indlæses den derefter. Downloads genoptages ved forsøg igen.
- Krav til native build: kør `pnpm approve-builds`, vælg `node-llama-cpp`, og kør derefter
  `pnpm rebuild node-llama-cpp`.
- Fallback: hvis lokal opsætning fejler og `memorySearch.fallback = "openai"`, skifter vi automatisk til
  fjern-embeddings (`openai/text-embedding-3-small` medmindre tilsidesat) og registrerer årsagen.

### Eksempel på brugerdefineret OpenAI-kompatibelt endpoint

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

Noter:

- `remote.*` har forrang over `models.providers.openai.*`.
- `remote.headers` fusionere med OpenAI headers; fjerntliggende vinder på centrale konflikter. Udelad `remote.headers` for at bruge OpenAI standardværdierne.
