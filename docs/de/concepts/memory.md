---
summary: „Wie der OpenClaw-Speicher funktioniert (Workspace-Dateien + automatischer Speicher-Flush)“
read_when:
  - Sie möchten das Layout und den Workflow der Speicherdateien verstehen
  - Sie möchten den automatischen Pre-Compaction-Speicher-Flush anpassen
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:31Z
---

# Speicher

Der OpenClaw-Speicher besteht aus **einfachem Markdown im Agent-Workspace**. Die Dateien sind die maßgebliche Quelle; das Modell „erinnert“ sich nur an das, was auf die Festplatte geschrieben wird.

Speicher-Suchwerkzeuge werden vom aktiven Speicher-Plugin bereitgestellt (Standard:
`memory-core`). Speicher-Plugins können mit `plugins.slots.memory = "none"` deaktiviert werden.

## Speicherdateien (Markdown)

Das Standard-Workspace-Layout verwendet zwei Speicherebenen:

- `memory/YYYY-MM-DD.md`
  - Tägliches Protokoll (nur anhängend).
  - Liest heute + gestern beim Sitzungsstart.
- `MEMORY.md` (optional)
  - Kuratierter Langzeitspeicher.
  - **Wird nur in der Haupt-, privaten Sitzung geladen** (niemals in Gruppenkontexten).

Diese Dateien liegen im Workspace (`agents.defaults.workspace`, Standard
`~/.openclaw/workspace`). Siehe [Agent workspace](/concepts/agent-workspace) für das vollständige Layout.

## Wann Speicher geschrieben werden sollte

- Entscheidungen, Präferenzen und dauerhafte Fakten gehören in `MEMORY.md`.
- Alltägliche Notizen und laufender Kontext gehören in `memory/YYYY-MM-DD.md`.
- Wenn jemand sagt „merk dir das“, schreiben Sie es auf (nicht im RAM behalten).
- Dieser Bereich entwickelt sich noch. Es hilft, das Modell daran zu erinnern, Speicher abzulegen; es weiß dann, was zu tun ist.
- Wenn etwas dauerhaft bleiben soll, **bitten Sie den Bot, es in den Speicher zu schreiben**.

## Automatischer Speicher-Flush (Pre-Compaction-Ping)

Wenn eine Sitzung **kurz vor der Auto-Kompaktierung** steht, löst OpenClaw einen **stillen,
agentischen Zug** aus, der das Modell daran erinnert, dauerhaften Speicher **vor** der
Kompaktierung des Kontexts zu schreiben. Die Standard-Prompts sagen ausdrücklich, dass das Modell _antworten darf_,
aber in der Regel ist `NO_REPLY` die richtige Antwort, sodass der Nutzer diesen Zug nie sieht.

Gesteuert wird dies über `agents.defaults.compaction.memoryFlush`:

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

- **Weicher Schwellenwert**: Der Flush wird ausgelöst, wenn die geschätzte Sitzungs-Tokenanzahl
  `contextWindow - reserveTokensFloor - softThresholdTokens` überschreitet.
- **Standardmäßig still**: Prompts enthalten `NO_REPLY`, sodass nichts ausgeliefert wird.
- **Zwei Prompts**: Ein Nutzer-Prompt plus ein System-Prompt hängen die Erinnerung an.
- **Ein Flush pro Kompaktierungszyklus** (nachverfolgt in `sessions.json`).
- **Workspace muss beschreibbar sein**: Läuft die Sitzung in einer Sandbox mit
  `workspaceAccess: "ro"` oder `"none"`, wird der Flush übersprungen.

Für den vollständigen Kompaktierungs-Lebenszyklus siehe
[Session management + compaction](/reference/session-management-compaction).

## Vektorbasierte Speichersuche

OpenClaw kann einen kleinen Vektorindex über `MEMORY.md` und `memory/*.md` aufbauen, sodass
semantische Abfragen verwandte Notizen finden können, selbst wenn sich die Wortwahl unterscheidet.

Standards:

- Standardmäßig aktiviert.
- Überwacht Speicherdateien auf Änderungen (entprellt).
- Verwendet standardmäßig Remote-Embeddings. Wenn `memorySearch.provider` nicht gesetzt ist, wählt OpenClaw automatisch:
  1. `local`, wenn ein `memorySearch.local.modelPath` konfiguriert ist und die Datei existiert.
  2. `openai`, wenn ein OpenAI-Schlüssel aufgelöst werden kann.
  3. `gemini`, wenn ein Gemini-Schlüssel aufgelöst werden kann.
  4. `voyage`, wenn ein Voyage-Schlüssel aufgelöst werden kann.
  5. Andernfalls bleibt die Speichersuche deaktiviert, bis sie konfiguriert wird.
- Der lokale Modus verwendet node-llama-cpp und erfordert ggf. `pnpm approve-builds`.
- Verwendet sqlite-vec (falls verfügbar), um die Vektorsuche innerhalb von SQLite zu beschleunigen.

Remote-Embeddings **erfordern** einen API-Schlüssel für den Embedding-Anbieter. OpenClaw
löst Schlüssel aus Auth-Profilen, `models.providers.*.apiKey` oder
Umgebungsvariablen auf. Codex OAuth deckt nur Chat/Completions ab und erfüllt **nicht**
die Anforderungen für Embeddings bei der Speichersuche. Für Gemini verwenden Sie `GEMINI_API_KEY` oder
`models.providers.google.apiKey`. Für Voyage verwenden Sie `VOYAGE_API_KEY` oder
`models.providers.voyage.apiKey`. Bei Verwendung eines benutzerdefinierten OpenAI-kompatiblen Endpunkts
setzen Sie `memorySearch.remote.apiKey` (und optional `memorySearch.remote.headers`).

### QMD-Backend (experimentell)

Setzen Sie `memory.backend = "qmd"`, um den eingebauten SQLite-Indexer durch
[QMD](https://github.com/tobi/qmd) zu ersetzen: einen Local-first-Such-Sidecar, der
BM25 + Vektoren + Reranking kombiniert. Markdown bleibt die maßgebliche Quelle; OpenClaw
ruft QMD für die Abfrage auf. Wichtige Punkte:

**Voraussetzungen**

- Standardmäßig deaktiviert. Opt-in pro Konfiguration (`memory.backend = "qmd"`).
- Installieren Sie die QMD-CLI separat (`bun install -g https://github.com/tobi/qmd` oder laden Sie
  ein Release) und stellen Sie sicher, dass das `qmd`-Binary im `PATH` des Gateways liegt.
- QMD benötigt einen SQLite-Build, der Erweiterungen erlaubt (`brew install sqlite` unter
  macOS).
- QMD läuft vollständig lokal über Bun + `node-llama-cpp` und lädt beim ersten Einsatz
  automatisch GGUF-Modelle von HuggingFace herunter (kein separater Ollama-Daemon erforderlich).
- Das Gateway führt QMD in einem eigenständigen XDG-Home unter
  `~/.openclaw/agents/<agentId>/qmd/` aus, indem `XDG_CONFIG_HOME` und
  `XDG_CACHE_HOME` gesetzt werden.
- Betriebssystem-Support: macOS und Linux funktionieren sofort, sobald Bun + SQLite
  installiert sind. Windows wird am besten über WSL2 unterstützt.

**Wie der Sidecar läuft**

- Das Gateway schreibt ein eigenständiges QMD-Home unter
  `~/.openclaw/agents/<agentId>/qmd/` (Konfiguration + Cache + SQLite-DB).
- Collections werden über `qmd collection add` aus `memory.qmd.paths`
  (plus Standard-Workspace-Speicherdateien) erstellt; anschließend laufen
  `qmd update` + `qmd embed` beim Start und in einem konfigurierbaren Intervall (`memory.qmd.update.interval`,
  Standard 5 Min.).
- Die Aktualisierung beim Start läuft nun standardmäßig im Hintergrund, damit der Chat-Start
  nicht blockiert wird; setzen Sie `memory.qmd.update.waitForBootSync = true`, um das frühere blockierende
  Verhalten beizubehalten.
- Suchen laufen über `qmd query --json`. Wenn QMD fehlschlägt oder das Binary fehlt,
  fällt OpenClaw automatisch auf den eingebauten SQLite-Manager zurück, sodass die Speicher-Tools
  weiter funktionieren.
- OpenClaw stellt derzeit keine Batch-Size-Abstimmung für QMD-Embeddings bereit; das Batch-Verhalten
  wird von QMD selbst gesteuert.
- **Erste Suche kann langsam sein**: QMD lädt beim ersten `qmd query`-Lauf
  möglicherweise lokale GGUF-Modelle (Reranker/Query-Expansion) herunter.
  - OpenClaw setzt `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automatisch, wenn es QMD ausführt.
  - Wenn Sie Modelle manuell vorab herunterladen möchten (und denselben Index vorwärmen,
    den OpenClaw verwendet), führen Sie eine einmalige Abfrage mit den XDG-Verzeichnissen des Agenten aus.

    Der QMD-Status von OpenClaw liegt unter Ihrem **State-Dir** (Standard: `~/.openclaw`).
    Sie können `qmd` auf exakt denselben Index zeigen lassen, indem Sie dieselben XDG-Variablen exportieren,
    die OpenClaw verwendet:

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

**Konfigurationsoberfläche (`memory.qmd.*`)**

- `command` (Standard `qmd`): überschreibt den Pfad zur ausführbaren Datei.
- `includeDefaultMemory` (Standard `true`): indiziert automatisch `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: fügt zusätzliche Verzeichnisse/Dateien hinzu (`path`, optional `pattern`, optional
  stabil `name`).
- `sessions`: Opt-in für Sitzungs-JSONL-Indizierung (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: steuert Aktualisierungsfrequenz und Wartungsausführung:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: begrenzt den Recall-Payload (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: gleiches Schema wie [`session.sendPolicy`](/gateway/configuration#session).
  Standard ist nur DM (`deny` alle, `allow` Direktchats); lockern Sie dies, um QMD-Treffer
  in Gruppen/Kanälen anzuzeigen.
- Snippets aus Quellen außerhalb des Workspace erscheinen als
  `qmd/<collection>/<relative-path>` in `memory_search`-Ergebnissen; `memory_get`
  versteht dieses Präfix und liest aus dem konfigurierten QMD-Collection-Root.
- Wenn `memory.qmd.sessions.enabled = true`, exportiert OpenClaw bereinigte Sitzungs-
  Transkripte (User/Assistant-Züge) in eine dedizierte QMD-Collection unter
  `~/.openclaw/agents/<id>/qmd/sessions/`, sodass `memory_search` kürzliche
  Unterhaltungen abrufen kann, ohne den eingebauten SQLite-Index zu berühren.
- `memory_search`-Snippets enthalten nun eine `Source: <path#line>`-Fußzeile, wenn
  `memory.citations` `auto`/`on` ist; setzen Sie `memory.citations = "off"`, um
  die Pfad-Metadaten intern zu halten (der Agent erhält den Pfad weiterhin für
  `memory_get`, aber der Snippet-Text lässt die Fußzeile weg und der System-Prompt
  warnt den Agenten, sie nicht zu zitieren).

**Beispiel**

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

**Zitate & Fallback**

- `memory.citations` gilt unabhängig vom Backend (`auto`/`on`/`off`).
- Wenn `qmd` läuft, markieren wir `status().backend = "qmd"`, sodass Diagnosen anzeigen,
  welche Engine die Ergebnisse geliefert hat. Wenn der QMD-Subprozess beendet wird oder JSON-Ausgaben
  nicht geparst werden können, protokolliert der Search-Manager eine Warnung und gibt den eingebauten Anbieter
  (bestehende Markdown-Embeddings) zurück, bis QMD sich erholt.

### Zusätzliche Speicherpfade

Wenn Sie Markdown-Dateien außerhalb des Standard-Workspace-Layouts indizieren möchten,
fügen Sie explizite Pfade hinzu:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Hinweise:

- Pfade können absolut oder workspace-relativ sein.
- Verzeichnisse werden rekursiv nach `.md`-Dateien durchsucht.
- Es werden nur Markdown-Dateien indiziert.
- Symlinks werden ignoriert (Dateien oder Verzeichnisse).

### Gemini-Embeddings (nativ)

Setzen Sie den Anbieter auf `gemini`, um die Gemini-Embeddings-API direkt zu verwenden:

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

Hinweise:

- `remote.baseUrl` ist optional (Standard ist die Basis-URL der Gemini-API).
- `remote.headers` ermöglicht das Hinzufügen zusätzlicher Header bei Bedarf.
- Standardmodell: `gemini-embedding-001`.

Wenn Sie einen **benutzerdefinierten OpenAI-kompatiblen Endpunkt** (OpenRouter, vLLM oder einen Proxy)
verwenden möchten, können Sie die `remote`-Konfiguration mit dem OpenAI-Anbieter nutzen:

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

Wenn Sie keinen API-Schlüssel setzen möchten, verwenden Sie `memorySearch.provider = "local"` oder setzen Sie
`memorySearch.fallback = "none"`.

Fallbacks:

- `memorySearch.fallback` kann `openai`, `gemini`, `local` oder `none` sein.
- Der Fallback-Anbieter wird nur verwendet, wenn der primäre Embedding-Anbieter fehlschlägt.

Batch-Indizierung (OpenAI + Gemini):

- Standardmäßig aktiviert für OpenAI- und Gemini-Embeddings. Setzen Sie `agents.defaults.memorySearch.remote.batch.enabled = false`, um sie zu deaktivieren.
- Das Standardverhalten wartet auf den Abschluss des Batches; passen Sie `remote.batch.wait`, `remote.batch.pollIntervalMs` und `remote.batch.timeoutMinutes` bei Bedarf an.
- Setzen Sie `remote.batch.concurrency`, um zu steuern, wie viele Batch-Jobs parallel eingereicht werden (Standard: 2).
- Der Batch-Modus gilt, wenn `memorySearch.provider = "openai"` oder `"gemini"` und verwendet den entsprechenden API-Schlüssel.
- Gemini-Batch-Jobs verwenden den asynchronen Embeddings-Batch-Endpunkt und erfordern die Verfügbarkeit der Gemini Batch API.

Warum OpenAI-Batches schnell + günstig sind:

- Für große Backfills ist OpenAI in der Regel die schnellste Option, die wir unterstützen, da wir viele Embedding-Anfragen in einem einzigen Batch-Job einreichen und OpenAI sie asynchron verarbeiten lassen können.
- OpenAI bietet rabattierte Preise für Batch-API-Workloads, sodass große Indizierungsläufe meist günstiger sind als das synchrone Senden derselben Anfragen.
- Siehe die OpenAI-Batch-API-Dokumente und Preise für Details:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Konfigurationsbeispiel:

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

Werkzeuge:

- `memory_search` — gibt Snippets mit Datei- und Zeilenbereichen zurück.
- `memory_get` — liest den Inhalt einer Speicherdatei anhand des Pfads.

Lokaler Modus:

- Setzen Sie `agents.defaults.memorySearch.provider = "local"`.
- Geben Sie `agents.defaults.memorySearch.local.modelPath` (GGUF oder `hf:`-URI) an.
- Optional: Setzen Sie `agents.defaults.memorySearch.fallback = "none"`, um Remote-Fallbacks zu vermeiden.

### Wie die Speicherwerkzeuge funktionieren

- `memory_search` durchsucht semantisch Markdown-Chunks (~400 Token Ziel, 80-Token-Überlappung) aus `MEMORY.md` + `memory/**/*.md`. Es gibt Snippet-Text (begrenzt auf ~700 Zeichen), Dateipfad, Zeilenbereich, Score, Anbieter/Modell und ob von lokalen → Remote-Embeddings zurückgefallen wurde, zurück. Es wird kein vollständiger Dateiinhalts-Payload zurückgegeben.
- `memory_get` liest eine bestimmte Speicher-Markdown-Datei (workspace-relativ), optional ab einer Startzeile und für N Zeilen. Pfade außerhalb von `MEMORY.md` / `memory/` werden abgelehnt.
- Beide Werkzeuge sind nur aktiviert, wenn `memorySearch.enabled` für den Agenten zu true aufgelöst wird.

### Was indiziert wird (und wann)

- Dateityp: nur Markdown (`MEMORY.md`, `memory/**/*.md`).
- Index-Speicher: pro Agent SQLite unter `~/.openclaw/memory/<agentId>.sqlite` (konfigurierbar über `agents.defaults.memorySearch.store.path`, unterstützt das `{agentId}`-Token).
- Aktualität: Watcher auf `MEMORY.md` + `memory/` markieren den Index als „dirty“ (Entprellung 1,5 s). Die Synchronisierung wird beim Sitzungsstart, bei einer Suche oder in einem Intervall geplant und läuft asynchron. Sitzungs-Transkripte verwenden Delta-Schwellen, um eine Hintergrund-Synchronisierung auszulösen.
- Reindex-Auslöser: Der Index speichert **Anbieter/Modell + Endpunkt-Fingerprint + Chunking-Parameter**. Wenn sich einer davon ändert, setzt OpenClaw den gesamten Store automatisch zurück und indiziert neu.

### Hybride Suche (BM25 + Vektor)

Wenn aktiviert, kombiniert OpenClaw:

- **Vektor-Ähnlichkeit** (semantische Übereinstimmung, Wortwahl kann variieren)
- **BM25-Schlüsselwort-Relevanz** (exakte Tokens wie IDs, Umgebungsvariablen, Code-Symbole)

Wenn Volltextsuche auf Ihrer Plattform nicht verfügbar ist, fällt OpenClaw auf eine reine Vektorsuche zurück.

#### Warum hybrid?

Vektorsuche ist hervorragend für „das bedeutet dasselbe“:

- „Mac Studio Gateway-Host“ vs. „die Maschine, auf der das Gateway läuft“
- „Dateiaktualisierungen entprellen“ vs. „Indizierung bei jedem Schreiben vermeiden“

Sie ist jedoch schwächer bei exakten, hochsignaligen Tokens:

- IDs (`a828e60`, `b3b9895a…`)
- Code-Symbole (`memorySearch.query.hybrid`)
- Fehlermeldungen („sqlite-vec unavailable“)

BM25 (Volltext) ist das Gegenteil: stark bei exakten Tokens, schwächer bei Paraphrasen.
Hybride Suche ist der pragmatische Mittelweg: **beide Retrieval-Signale nutzen**, sodass Sie
gute Ergebnisse sowohl für „natürliche Sprache“-Abfragen als auch für „Nadel im Heuhaufen“-Abfragen erhalten.

#### Wie wir Ergebnisse zusammenführen (aktuelles Design)

Implementierungsskizze:

1. Abruf eines Kandidatenpools von beiden Seiten:

- **Vektor**: Top `maxResults * candidateMultiplier` nach Kosinus-Ähnlichkeit.
- **BM25**: Top `maxResults * candidateMultiplier` nach FTS5-BM25-Rang (niedriger ist besser).

2. Umwandlung des BM25-Rangs in einen 0..1-ähnlichen Score:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Vereinigung der Kandidaten nach Chunk-ID und Berechnung eines gewichteten Scores:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Hinweise:

- `vectorWeight` + `textWeight` werden bei der Konfigurationsauflösung auf 1,0 normiert, sodass die Gewichte wie Prozentwerte wirken.
- Wenn Embeddings nicht verfügbar sind (oder der Anbieter einen Null-Vektor zurückgibt), führen wir weiterhin BM25 aus und geben Schlüsselworttreffer zurück.
- Wenn FTS5 nicht erstellt werden kann, behalten wir die reine Vektorsuche bei (kein harter Fehler).

Das ist nicht „IR-theoretisch perfekt“, aber einfach, schnell und verbessert in der Praxis häufig Recall/Precision auf realen Notizen.
Wenn wir es später ausbauen wollen, sind gängige nächste Schritte Reciprocal Rank Fusion (RRF) oder Score-Normalisierung
(Min/Max oder Z-Score) vor dem Mischen.

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

### Embedding-Cache

OpenClaw kann **Chunk-Embeddings** in SQLite zwischenspeichern, sodass Reindizierung und häufige Updates
(insbesondere Sitzungs-Transkripte) unveränderten Text nicht erneut einbetten.

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

### Sitzungs-Speichersuche (experimentell)

Optional können Sie **Sitzungs-Transkripte** indizieren und über `memory_search` verfügbar machen.
Dies ist hinter einem experimentellen Flag abgesichert.

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

Hinweise:

- Die Sitzungsindizierung ist **Opt-in** (standardmäßig aus).
- Sitzungsaktualisierungen werden entprellt und **asynchron indiziert**, sobald sie Delta-Schwellen überschreiten (Best-Effort).
- `memory_search` blockiert niemals auf die Indizierung; Ergebnisse können leicht veraltet sein, bis die Hintergrund-Synchronisierung abgeschlossen ist.
- Ergebnisse enthalten weiterhin nur Snippets; `memory_get` bleibt auf Speicherdateien beschränkt.
- Die Sitzungsindizierung ist pro Agent isoliert (es werden nur die Sitzungsprotokolle dieses Agenten indiziert).
- Sitzungsprotokolle liegen auf der Festplatte (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Jeder Prozess/Nutzer mit Dateisystemzugriff kann sie lesen; betrachten Sie daher den Festplattenzugriff als Vertrauensgrenze. Für strengere Isolation führen Sie Agenten unter separaten OS-Benutzern oder Hosts aus.

Delta-Schwellen (Standardwerte angezeigt):

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

### SQLite-Vektor-Beschleunigung (sqlite-vec)

Wenn die sqlite-vec-Erweiterung verfügbar ist, speichert OpenClaw Embeddings in einer
SQLite-virtuellen Tabelle (`vec0`) und führt Vektor-Distanzabfragen in der
Datenbank aus. Das hält die Suche schnell, ohne jedes Embedding in JS zu laden.

Konfiguration (optional):

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

Hinweise:

- `enabled` ist standardmäßig true; wenn deaktiviert, fällt die Suche auf eine In-Process-
  Kosinus-Ähnlichkeit über gespeicherte Embeddings zurück.
- Wenn die sqlite-vec-Erweiterung fehlt oder nicht geladen werden kann, protokolliert OpenClaw den
  Fehler und fährt mit dem JS-Fallback fort (keine Vektortabelle).
- `extensionPath` überschreibt den mitgelieferten sqlite-vec-Pfad (nützlich für Custom-Builds
  oder nicht standardisierte Installationsorte).

### Automatischer Download lokaler Embeddings

- Standardmäßiges lokales Embedding-Modell: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- Wenn `memorySearch.provider = "local"`, löst `node-llama-cpp` `modelPath` auf; fehlt das GGUF, wird es **automatisch heruntergeladen** in den Cache (oder `local.modelCacheDir`, falls gesetzt) und anschließend geladen. Downloads werden bei Wiederholung fortgesetzt.
- Native-Build-Anforderung: führen Sie `pnpm approve-builds` aus, wählen Sie `node-llama-cpp`, dann `pnpm rebuild node-llama-cpp`.
- Fallback: Wenn das lokale Setup fehlschlägt und `memorySearch.fallback = "openai"`, wechseln wir automatisch zu Remote-Embeddings (`openai/text-embedding-3-small`, sofern nicht überschrieben) und protokollieren den Grund.

### Beispiel für einen benutzerdefinierten OpenAI-kompatiblen Endpunkt

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

Hinweise:

- `remote.*` hat Vorrang vor `models.providers.openai.*`.
- `remote.headers` werden mit OpenAI-Headern zusammengeführt; bei Schlüsselkonflikten gewinnt Remote. Lassen Sie `remote.headers` weg, um die OpenAI-Standardwerte zu verwenden.
