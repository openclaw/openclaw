---
summary: "Hur OpenClaw-minne fungerar (arbetsytans filer + automatisk minnesspolning)"
read_when:
  - Du vill ha filstrukturen och arbetsflödet för minne
  - Du vill finjustera den automatiska förkompakterings-spolningen av minne
---

# Minne

OpenClaw minne är **vanligt markdown i agentutrymmet**. Filerna är
sanningskällan; modellen bara "minnas" vad som skrivs till disken.

Minnessökverktyg tillhandahålls av det aktiva minnestillägget (standard:
`memory-core`). Inaktivera minnesplugins med `plugins.slots.memory = "none"`.

## Minnesfiler (Markdown)

Standardlayouten för arbetsytan använder två minneslager:

- `memory/YYYY-MM-DD.md`
  - Daglig logg (endast tillägg).
  - Läs idag + igår vid sessionsstart.
- `MEMORY.md` (valfri)
  - Kurerat långtidsminne.
  - **Läs endast i den huvudsakliga, privata sessionen** (aldrig i gruppsammanhang).

Dessa filer lever under arbetsytan (`agents.defaults.workspace`, standard
`~/.openclaw/workspace`). Se [Agentens arbetsyta](/concepts/agent-workspace) för den fullständiga layouten.

## När ska minne skrivas

- Beslut, preferenser och varaktiga fakta hör hemma i `MEMORY.md`.
- Dagliga anteckningar och löpande kontext hör hemma i `memory/YYYY-MM-DD.md`.
- Om någon säger ”kom ihåg detta”, skriv ner det (behåll det inte i RAM).
- Detta område utvecklas fortfarande. Det hjälper till att påminna modellen för att lagra minnen; det kommer att veta vad man ska göra.
- Om du vill att något ska bestå, **be boten att skriva det** till minnet.

## Automatisk minnesspolning (förkompakterings-ping)

När en session är **nära automatisk komprimering**, utlöser OpenClaw en **tyst,
agentic turn** som påminner modellen att skriva hållbart minne **innan** sammanhanget
är kompakt. Standardprompten säger explicit att modellen _may reply_,
men brukar `NO_REPLY` är det rätta svaret så att användaren aldrig ser denna tur.

Detta styrs av `agents.defaults.compaction.memoryFlush`:

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

- **Mjuk tröskel**: spolning triggas när sessionens token-estimat passerar
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Tyst** som standard: prompter inkluderar `NO_REPLY` så inget levereras.
- **Två prompter**: en användarprompt plus en systemprompt lägger till påminnelsen.
- **En spolning per kompakteringscykel** (spåras i `sessions.json`).
- **Arbetsytan måste vara skrivbar**: om sessionen körs sandboxad med
  `workspaceAccess: "ro"` eller `"none"`, hoppas spolningen över.

För hela kompakteringslivscykeln, se
[Session management + compaction](/reference/session-management-compaction).

## Vektorminnesökning

OpenClaw kan bygga ett litet vektorindex över `MEMORY.md` och `memory/*.md` så
semantiska frågor kan hitta relaterade anteckningar även när formuleringar skiljer sig.

Standardvärden:

- Aktiverad som standard.
- Bevakar minnesfiler efter ändringar (debounce).
- Använder fjärrinbäddning som standard. Om `memorySearch.provider` inte är satt, är OpenClaw auto-selects:
  1. `local` om en `memorySearch.local.modelPath` är konfigurerad och filen finns.
  2. `openai` om en OpenAI-nyckel kan lösas.
  3. `gemini` om en Gemini-nyckel kan lösas.
  4. `voyage` om en Voyage-nyckel kan lösas.
  5. Annars förblir minnessökning inaktiverad tills den konfigureras.
- Lokalt läge använder node-llama-cpp och kan kräva `pnpm approve-builds`.
- Använder sqlite-vec (när tillgängligt) för att accelerera vektorsökning i SQLite.

Fjärrbäddningar **kräver** en API-nyckel för inbäddningsleverantören. OpenClaw
löser nycklar från auth profiler, `models.providers.*.apiKey`, eller miljö
variabler. Codex OAuth täcker endast chatt/kompletteringar och uppfyller **inte**
inbäddning för minnessökning. För Gemini, använd `GEMINI_API_KEY` eller
`models.providers.google.apiKey`. För resor använder du `VOYAGE_API_KEY` eller
`models.providers.voyage.apiKey`. När du använder en egen OpenAI-kompatibel slutpunkt, sätt
`memorySearch.remote.apiKey` (och valfritt `memorySearch.remote.headers`).

### QMD-backend (experimentell)

Ange `minne. ackend = "qmd"` för att byta den inbyggda SQLite-indexeraren mot
[QMD](https://github.com/tobi/qmd): en lokal första söksida som kombinerar
BM25 + vektorer + reranking. Markdown förblir källan till sanning; OpenClaw skal
ut till QMD för hämtning. Viktiga punkter:

**Förutsättningar**

- Inaktiverad som standard. Opt in per-config (`memory.backend = "qmd"`).
- Installera QMD CLI separat (`bun install -g https://github.com/tobi/qmd` eller hämta
  en release) och säkerställ att `qmd`-binären finns på gatewayens `PATH`.
- QMD behöver en SQLite-byggnad som tillåter tillägg (`brew install sqlite` på
  macOS).
- QMD kör helt lokalt via Bun + `node-llama-cpp` och laddar automatiskt ner GGUF-
  modeller från HuggingFace vid första användning (ingen separat Ollama-daemon krävs).
- Gatewayen kör QMD i ett självbärande XDG-hem under
  `~/.openclaw/agents/<agentId>/qmd/` genom att sätta `XDG_CONFIG_HOME` och
  `XDG_CACHE_HOME`.
- OS-stöd: macOS och Linux fungerar ur lådan när Bun + SQLite är
  installerade. Windows stöds bäst via WSL2.

**Hur sidecaren körs**

- Gatewayen skriver ett självbärande QMD-hem under
  `~/.openclaw/agents/<agentId>/qmd/` (konfig + cache + sqlite-DB).
- Samlingar skapas via `qmd collection add` från `memory.qmd.paths`
  (plus standardminnesfiler i arbetsytan), därefter körs `qmd update` + `qmd embed`
  vid uppstart och på ett konfigurerbart intervall (`memory.qmd.update.interval`,
  standard 5 m).
- Uppstartsuppdatering kör nu i bakgrunden som standard så att chattstart inte blockeras; sätt `memory.qmd.update.waitForBootSync = true` för att behålla tidigare blockerande beteende.
- Sökningar som körs via `qmd fråga --json`. Om QMD misslyckas eller binären saknas, faller
  OpenClaw automatiskt tillbaka till den inbyggda SQLite-hanteraren så minnesverktygen
  fungerar.
- OpenClaw exponerar inte justering av QMD:s inbäddningsbatchstorlek i nuläget; batchbeteende styrs av QMD självt.
- **Första sökningen kan vara långsam**: QMD kan ladda ner lokala GGUF-modeller (reranker/frågeexpansion) vid första `qmd query`-körningen.
  - OpenClaw sätter `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automatiskt när QMD körs.
  - Om du vill förladda modeller manuellt (och värma samma index som OpenClaw använder), kör en engångsfråga med agentens XDG-kataloger.

    OpenClaws QMD-tillstånd lever under din **state dir** (standard är `~/.openclaw`).
    Du kan peka `qmd` på exakt samma index genom att exportera samma XDG vars
    OpenClaw använder:

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

**Konfigyta (`memory.qmd.*`)**

- `command` (standard `qmd`): åsidosätt körbar sökväg.
- `includeDefaultMemory` (standard `true`): autoindexera `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: lägg till extra kataloger/filer (`path`, valfri `pattern`, valfri
  stabil `name`).
- `sessions`: välj in indexering av sessioners JSONL (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: styr uppdateringskadens och underhållskörning:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: begränsa återkallningspayload (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: samma schema som [`session.sendPolicy`](/gateway/configuration#session).
  Standard är endast DM-(`deny` all, `allow` direktchattar); lossa den till ytan QMD
  träffar i grupper/kanaler.
- Utdrag hämtade utanför arbetsytan visas som
  `qmd/<collection>/<relative-path>` i `memory_search`-resultat; `memory_get`
  förstår prefixet och läser från den konfigurerade QMD-samlingens rot.
- När `memory.qmd.sessions.enabled = true`, exporterar OpenClaw sanerade sessionsutskrifter
  (Användar-/Assistent-turer) till en dedikerad QMD-samling under
  `~/.openclaw/agents/<id>/qmd/sessions/`, så att `memory_search` kan återkalla senaste
  konversationer utan att röra den inbyggda SQLite-indexen.
- `memory_search`-utdrag inkluderar nu en `Source: <path#line>`-sidfot när
  `memory.citations` är `auto`/`on`; sätt `memory.citations = "off"` för att hålla sökvägsmetadata intern (agenten får fortfarande sökvägen för
  `memory_get`, men utdragstexten utelämnar sidfoten och systemprompten varnar agenten att inte citera den).

**Exempel**

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

**Citat & fallback**

- `memory.citations` gäller oavsett backend (`auto`/`on`/`off`).
- När `qmd` körs taggar vi `status().backend = "qmd"` så diagnostik visar vilken
  motor som tjänade resultatet. Om QMD delprocessen avslutas eller JSON utdata inte kan
  tolkas, sökhanteraren loggar en varning och returnerar den inbyggda leverantören
  (befintliga Markdown inbäddar) tills QMD återställs.

### Ytterligare minnesvägar

Om du vill indexera Markdown-filer utanför standardlayouten för arbetsytan, lägg till explicita sökvägar:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Noteringar:

- Sökvägar kan vara absoluta eller arbetsyterelativa.
- Kataloger skannas rekursivt efter `.md`-filer.
- Endast Markdown-filer indexeras.
- Symlänkar ignoreras (filer eller kataloger).

### Gemini-embeddings (native)

Sätt leverantören till `gemini` för att använda Gemini-embeddings-API:t direkt:

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

Noteringar:

- `remote.baseUrl` är valfri (standard är Geminis API-bas-URL).
- `remote.headers` låter dig lägga till extra headers vid behov.
- Standardmodell: `gemini-embedding-001`.

Om du vill använda en **anpassad OpenAI-kompatibel endpoint** (OpenRouter, vLLM eller en proxy),
kan du använda konfigurationen `remote` med OpenAI-leverantören:

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

Om du inte vill sätta en API-nyckel, använd `memorySearch.provider = "local"` eller sätt
`memorySearch.fallback = "none"`.

Fallbacks:

- `memorySearch.fallback` kan vara `openai`, `gemini`, `local` eller `none`.
- Fallback-leverantören används endast när den primära embeddingsleverantören misslyckas.

Batchindexering (OpenAI + Gemini):

- Aktiverad som standard för inbäddning av OpenAI och Gemini. Ange `agents.defaults.memorySearch.remote.batch.enabled = false` för att inaktivera.
- Standardbeteendet väntar på batchslutförande; justera `remote.batch.wait`, `remote.batch.pollIntervalMs` och `remote.batch.timeoutMinutes` vid behov.
- Sätt `remote.batch.concurrency` för att styra hur många batchjobb som skickas parallellt (standard: 2).
- Batchläge gäller när `memorySearch.provider = "openai"` eller `"gemini"` och använder motsvarande API-nyckel.
- Gemini-batchjobb använder den asynkrona embeddings-batchendpointen och kräver tillgänglighet för Gemini Batch API.

Varför OpenAI-batch är snabbt + billigt:

- För stora återfyllnader är OpenAI vanligtvis det snabbaste alternativet vi stöder eftersom vi kan skicka många embeddingsförfrågningar i ett enda batchjobb och låta OpenAI bearbeta dem asynkront.
- OpenAI erbjuder rabatterad prissättning för Batch API-arbetslaster, så stora indexeringskörningar är oftast billigare än att skicka samma förfrågningar synkront.
- Se OpenAI Batch API-dokumentationen och prissättning för detaljer:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Konfigexempel:

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

Verktyg:

- `memory_search` — returnerar utdrag med fil- och radintervall.
- `memory_get` — läser minnesfilens innehåll via sökväg.

Lokalt läge:

- Sätt `agents.defaults.memorySearch.provider = "local"`.
- Ange `agents.defaults.memorySearch.local.modelPath` (GGUF eller `hf:`-URI).
- Valfritt: sätt `agents.defaults.memorySearch.fallback = "none"` för att undvika fjärr-fallback.

### Hur minnesverktygen fungerar

- `memory_search` semantiskt söker Markdown chunks (~400 token target, 80-token overlap) från `MEMORY.md` + `memory/**/*.md`. Den returnerar textutdrag (capped ~700 tecken), filsökväg, linjesortiment, poäng, leverantör / modell, och om vi föll tillbaka från lokala → fjärranslutningar. Ingen full nyttolast för filen returneras.
- `memory_get` läser en specifik minnesmarkdown-fil (arbetsyta-relativ), alternativt från en startlinje och för N-linjer. Sökvägar utanför `MEMORY.md` / `minne/` avvisas.
- Båda verktygen är aktiverade endast när `memorySearch.enabled` löses till true för agenten.

### Vad som indexeras (och när)

- Filtyp: endast Markdown (`MEMORY.md`, `memory/**/*.md`).
- Indexlagring: per-agent SQLite på `~/.openclaw/memory/<agentId>.sqlite` (konfigurerbar via `agents.defaults.memorySearch.store.path`, stöder `{agentId}`-token).
- Freshness: betraktare på `MEMORY.md` + `minne/` markerar indexet smutsigt (debounce 1.5s). Synkronisering är schemalagd vid start av sessionen, vid sökning eller på ett intervall och körs asynkront. Sessionsutskrifter använder deltatrösklar för att utlösa bakgrundssynkronisering.
- Reindex triggers: index lagrar inbäddning **leverantör/modell + endpoint fingeravtryck + chunking params**. Om någon av dessa ändringar, återställer och indexerar OpenClaw automatiskt hela butiken.

### Hybridsökning (BM25 + vektor)

När den är aktiverad kombinerar OpenClaw:

- **Vektorsimilaritet** (semantisk match, formulering kan skilja)
- **BM25-nyckelordsrelevans** (exakta tokens som ID:n, miljövariabler, kodsymboler)

Om fulltextsökning inte är tillgänglig på din plattform faller OpenClaw tillbaka till endast vektorsökning.

#### Varför hybrid?

Vektorsökning är bra på ”detta betyder samma sak”:

- ”Mac Studio gateway-värd” vs ”maskinen som kör gatewayen”
- ”debounce filuppdateringar” vs ”undvik indexering vid varje skrivning”

Men den kan vara svag på exakta, högsignalstokens:

- ID:n (`a828e60`, `b3b9895a…`)
- kodsymboler (`memorySearch.query.hybrid`)
- felsträngar (“sqlite-vec unavailable”)

BM25 (fulltext) är motsatsen: stark vid exakta tokens, svagare vid parafraser.
Hybrid search är den pragmatiska mittfältet: **använd båda hämtningssignaler** så att du får
bra resultat för både “naturspråk” frågor och “nål i en haystack” frågor.

#### Hur vi slår ihop resultat (nuvarande design)

Implementationsskiss:

1. Hämta en kandidatpool från båda sidor:

- **Vektor**: topp `maxResults * candidateMultiplier` efter cosinuslikhet.
- **BM25**: topp `maxResults * candidateMultiplier` efter FTS5 BM25-rankning (lägre är bättre).

2. Konvertera BM25-rankning till ett 0..1-liknande betyg:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Slå ihop kandidater efter chunk-id och beräkna ett viktat betyg:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Noteringar:

- `vectorWeight` + `textWeight` normaliseras till 1,0 i konfigupplösning, så vikter beter sig som procenttal.
- Om embeddings inte är tillgängliga (eller om leverantören returnerar en nollvektor) kör vi ändå BM25 och returnerar nyckelordsträffar.
- Om FTS5 inte kan skapas behåller vi endast vektorsökning (inget hårt fel).

Detta är inte “IR-teori perfekt”, men det är enkelt, snabbt och tenderar att förbättra återkallande/precision på verkliga anteckningar.
Om vi vill få finare senare, vanliga nästa steg är Reciprocal Rank Fusion (RRF) eller poäng normalisering
(min/max eller z-poäng) innan blandning.

Konfig:

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

### Inbäddningscache

OpenClaw kan cache:a **chunk-embeddings** i SQLite så att omindexering och frekventa uppdateringar (särskilt sessionsutskrifter) inte återinbäddar oförändrad text.

Konfig:

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

### Sessionsminnessökning (experimentell)

Du kan eventuellt indexera **sessionsutskrifter** och ytbehandla dem via `memory_search`.
Detta är gated bakom en experimentell flagga.

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

Noteringar:

- Sessionsindexering är **opt-in** (avstängd som standard).
- Sessionsuppdateringar debouncas och **indexeras asynkront** när de passerar deltatrösklar (best effort).
- `memory_search` blockerar aldrig på indexering; resultat kan vara något inaktuella tills bakgrundssynk är klar.
- Resultat innehåller fortfarande endast utdrag; `memory_get` förblir begränsad till minnesfiler.
- Sessionsindexering är isolerad per agent (endast den agentens sessionsloggar indexeras).
- Sessionsloggar live på disk (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Alla process/användare med filsystemsåtkomst kan läsa dem, så behandla diskåtkomst som förtroendegränsen. För strängare isolering, kör agenter under separata OS-användare eller värdar.

Deltatrösklar (standardvärden visas):

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

När sqlite-vec tillägget är tillgängligt, lagrar OpenClaw inbäddning i en
SQLite virtuell tabell (`vec0`) och utför vektordistansfrågor i databasen
. Detta håller sökandet snabbt utan att ladda varje inbäddning i JS.

Konfiguration (valfri):

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

Noteringar:

- `enabled` är true som standard; när den inaktiveras faller sökningen tillbaka till
  in-process cosinuslikhet över lagrade embeddings.
- Om sqlite-vec-tillägget saknas eller inte kan laddas loggar OpenClaw felet och fortsätter med JS-fallback (ingen vektortabell).
- `extensionPath` åsidosätter den medföljande sqlite-vec-sökvägen (användbart för anpassade byggen
  eller icke-standardiserade installationsplatser).

### Lokal inbäddnings-autonedladdning

- Standardmodell för lokala embeddings: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- När `memorySearch.provider = "local"`, `node-llama-cpp` löser `modelPath`; om GGUF saknar det **auto-downloads** till cachen (eller `local.modelCacheDir` om set), laddar sedan den. Nedladdningar återupptas vid återförsök.
- Krav för native-build: kör `pnpm approve-builds`, välj `node-llama-cpp`, därefter `pnpm rebuild node-llama-cpp`.
- Fallback: om lokal konfiguration misslyckas och `memorySearch.fallback = "openai"`, byter vi automatiskt till fjärr-embeddings (`openai/text-embedding-3-small` om inte åsidosatt) och registrerar orsaken.

### Exempel på anpassad OpenAI-kompatibel endpoint

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

Noteringar:

- `remote.*` har företräde framför `models.providers.openai.*`.
- `remote.headers` sammanfoga med OpenAI-huvuden; fjärråtkomst på nyckelkonflikter. Utelämna `remote.headers` för att använda OpenAI-standarderna.
