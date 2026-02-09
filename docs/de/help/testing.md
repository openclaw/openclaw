---
summary: "„Testkit: Unit-/E2E-/Live-Suiten, Docker-Runner und was jeder Test abdeckt“"
read_when:
  - Beim lokalen Ausführen von Tests oder in CI
  - Beim Hinzufügen von Regressionen für Modell-/Anbieter-Bugs
  - Beim Debuggen des Gateway- und Agent-Verhaltens
title: "„Tests“"
---

# Tests

OpenClaw hat drei Vitest-Suiten (Unit/Integration, E2E, Live) sowie eine kleine Auswahl an Docker-Runnern.

Dieses Dokument ist ein Leitfaden „wie wir testen“:

- Was jede Suite abdeckt (und was sie bewusst _nicht_ abdeckt)
- Welche Befehle für gängige Workflows auszuführen sind (lokal, vor dem Push, Debugging)
- Wie Live-Tests Zugangsdaten finden und Modelle/Anbieter auswählen
- Wie Regressionen für reale Modell-/Anbieter-Probleme hinzugefügt werden

## Schnellstart

An den meisten Tagen:

- Vollständiges Gate (vor dem Push erwartet): `pnpm build && pnpm check && pnpm test`

Wenn Sie Tests anfassen oder zusätzliche Sicherheit wollen:

- Coverage-Gate: `pnpm test:coverage`
- E2E-Suite: `pnpm test:e2e`

Beim Debuggen realer Anbieter/Modelle (erfordert echte Zugangsdaten):

- Live-Suite (Modelle + Gateway-Werkzeug-/Image-Probes): `pnpm test:live`

Tipp: Wenn Sie nur einen einzelnen fehlschlagenden Fall benötigen, bevorzugen Sie das Eingrenzen der Live-Tests über die unten beschriebenen Allowlist-Umgebungsvariablen.

## Test-Suiten (was wo läuft)

Betrachten Sie die Suiten als „zunehmenden Realismus“ (und zunehmende Flakiness/Kosten):

### Unit / Integration (Standard)

- Befehl: `pnpm test`
- Konfiguration: `vitest.config.ts`
- Dateien: `src/**/*.test.ts`
- Umfang:
  - Reine Unit-Tests
  - In-Prozess-Integrationstests (Gateway-Auth, Routing, Tooling, Parsing, Konfiguration)
  - Deterministische Regressionen für bekannte Bugs
- Erwartungen:
  - Läuft in CI
  - Keine echten Schlüssel erforderlich
  - Sollte schnell und stabil sein

### E2E (Gateway-Smoke)

- Befehl: `pnpm test:e2e`
- Konfiguration: `vitest.e2e.config.ts`
- Dateien: `src/**/*.e2e.test.ts`
- Umfang:
  - End-to-End-Verhalten des Gateways mit mehreren Instanzen
  - WebSocket-/HTTP-Oberflächen, Node-Pairing und schwerere Netzwerklast
- Erwartungen:
  - Läuft in CI (wenn in der Pipeline aktiviert)
  - Keine echten Schlüssel erforderlich
  - Mehr bewegliche Teile als Unit-Tests (kann langsamer sein)

### Live (reale Anbieter + reale Modelle)

- Befehl: `pnpm test:live`
- Konfiguration: `vitest.live.config.ts`
- Dateien: `src/**/*.live.test.ts`
- Standard: **aktiviert** durch `pnpm test:live` (setzt `OPENCLAW_LIVE_TEST=1`)
- Umfang:
  - „Funktioniert dieser Anbieter/dieses Modell _heute_ tatsächlich mit echten Zugangsdaten?“
  - Erkennen von Anbieter-Formatänderungen, Tool-Calling-Eigenheiten, Auth-Problemen und Rate-Limit-Verhalten
- Erwartungen:
  - Absichtlich nicht CI-stabil (reale Netzwerke, reale Anbieter-Richtlinien, Kontingente, Ausfälle)
  - Verursacht Kosten / nutzt Rate Limits
  - Bevorzugen Sie eingegrenzte Teilmengen statt „alles“
  - Live-Läufe beziehen `~/.profile`, um fehlende API-Schlüssel zu finden
  - Anthropic-Schlüsselrotation: Setzen Sie `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (oder `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) oder mehrere `ANTHROPIC_API_KEY*`-Variablen; Tests wiederholen bei Rate Limits

## Welche Suite sollte ich ausführen?

Verwenden Sie diese Entscheidungshilfe:

- Logik/Tests bearbeiten: `pnpm test` ausführen (und `pnpm test:coverage`, wenn Sie viel geändert haben)
- Gateway-Netzwerk / WS-Protokoll / Pairing anfassen: `pnpm test:e2e` hinzufügen
- Debugging von „mein Bot ist down“ / anbieterspezifische Fehler / Tool-Calling: eine eingegrenzte `pnpm test:live` ausführen

## Live: Modell-Smoke (Profil-Schlüssel)

Live-Tests sind in zwei Ebenen aufgeteilt, um Fehler zu isolieren:

- „Direktes Modell“ zeigt, dass der Anbieter/das Modell mit dem gegebenen Schlüssel grundsätzlich antworten kann.
- „Gateway-Smoke“ zeigt, dass die komplette Gateway+Agent-Pipeline für dieses Modell funktioniert (Sitzungen, Verlauf, Tools, Sandbox-Richtlinien usw.).

### Ebene 1: Direkte Modell-Completion (kein Gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Ziel:
  - Erkannte Modelle auflisten
  - Mit `getApiKeyForModel` Modelle auswählen, für die Sie Zugangsdaten haben
  - Pro Modell eine kleine Completion ausführen (und gezielte Regressionen, wo nötig)
- So wird aktiviert:
  - `pnpm test:live` (oder `OPENCLAW_LIVE_TEST=1`, wenn Vitest direkt aufgerufen wird)
- Setzen Sie `OPENCLAW_LIVE_MODELS=modern` (oder `all`, Alias für modern), um diese Suite tatsächlich auszuführen; andernfalls wird sie übersprungen, damit `pnpm test:live` auf Gateway-Smoke fokussiert bleibt
- Modellauswahl:
  - `OPENCLAW_LIVE_MODELS=modern` für die moderne Allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` ist ein Alias für die moderne Allowlist
  - oder `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (Komma-Allowlist)
- Anbieterauswahl:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (Komma-Allowlist)
- Herkunft der Schlüssel:
  - Standard: Profil-Store und Env-Fallbacks
  - Setzen Sie `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`, um **nur** den Profil-Store zu erzwingen
- Warum es das gibt:
  - Trennt „Anbieter-API ist kaputt / Schlüssel ist ungültig“ von „Gateway-Agent-Pipeline ist kaputt“
  - Enthält kleine, isolierte Regressionen (Beispiel: OpenAI Responses/Codex Responses Reasoning-Replay + Tool-Call-Flows)

### Ebene 2: Gateway + Dev-Agent-Smoke (das, was „@openclaw“ tatsächlich tut)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Ziel:
  - Ein In-Process Gateway aufdrehen
  - Eine `agent:dev:*`-Sitzung erstellen/patchen (Modell-Override pro Lauf)
  - Modelle-mit-Schlüsseln iterieren und prüfen:
    - „sinnvolle“ Antwort (keine Tools)
    - eine echte Tool-Invocation funktioniert (Read-Probe)
    - optionale zusätzliche Tool-Probes (Exec+Read-Probe)
    - OpenAI-Regressionspfade (nur Tool-Call → Follow-up) funktionieren weiterhin
- Probe-Details (damit Sie Fehler schnell erklären können):
  - `read`-Probe: Der Test schreibt eine Nonce-Datei in den Workspace und bittet den Agenten, sie zu `read` und die Nonce zurückzugeben.
  - `exec+read`-Probe: Der Test bittet den Agenten, per `exec` eine Nonce in eine Temp-Datei zu schreiben und sie anschließend per `read` zurückzugeben.
  - Image-Probe: Der Test hängt eine generierte PNG (Katze + randomisierter Code) an und erwartet, dass das Modell `cat <CODE>` zurückgibt.
  - Implementierungsreferenz: `src/gateway/gateway-models.profiles.live.test.ts` und `src/gateway/live-image-probe.ts`.
- So wird aktiviert:
  - `pnpm test:live` (oder `OPENCLAW_LIVE_TEST=1`, wenn Vitest direkt aufgerufen wird)
- Modellauswahl:
  - Standard: moderne Allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` ist ein Alias für die moderne Allowlist
  - Oder setzen Sie `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (oder Kommaliste) zur Eingrenzung
- Anbieterauswahl (vermeiden Sie „OpenRouter alles“):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (Komma-Allowlist)
- Tool- und Image-Probes sind in diesem Live-Test immer aktiv:
  - `read`-Probe + `exec+read`-Probe (Tool-Stress)
  - Image-Probe läuft, wenn das Modell Image-Input unterstützt
  - Ablauf (auf hoher Ebene):
    - Test generiert eine kleine PNG mit „CAT“ + Zufallscode (`src/gateway/live-image-probe.ts`)
    - Sendet sie via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parst Anhänge in `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Eingebetteter Agent leitet eine multimodale Nutzernachricht an das Modell weiter
    - Assertion: Antwort enthält `cat` + den Code (OCR-Toleranz: kleine Fehler erlaubt)

Tipp: Um zu sehen, was Sie auf Ihrer Maschine testen können (und die exakten `provider/model`-IDs), führen Sie aus:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic Setup-Token-Smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Ziel: Verifizieren, dass das Claude Code CLI Setup-Token (oder ein eingefügtes Setup-Token-Profil) einen Anthropic-Prompt abschließen kann.
- Aktivieren:
  - `pnpm test:live` (oder `OPENCLAW_LIVE_TEST=1`, wenn Vitest direkt aufgerufen wird)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Token-Quellen (eine auswählen):
  - Profil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Rohes Token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Modell-Override (optional):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Setup-Beispiel:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI-Backend-Smoke (Claude Code CLI oder andere lokale CLIs)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Ziel: Validieren der Gateway- + Agent-Pipeline mit einem lokalen CLI-Backend, ohne Ihre Standardkonfiguration anzutasten.
- Aktivieren:
  - `pnpm test:live` (oder `OPENCLAW_LIVE_TEST=1`, wenn Vitest direkt aufgerufen wird)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Standards:
  - Modell: `claude-cli/claude-sonnet-4-5`
  - Befehl: `claude`
  - Argumente: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (optional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1`, um einen echten Image-Anhang zu senden (Pfade werden in den Prompt injiziert).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"`, um Image-Dateipfade als CLI-Argumente statt per Prompt-Injektion zu übergeben.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (oder `"list"`), um zu steuern, wie Image-Args übergeben werden, wenn `IMAGE_ARG` gesetzt ist.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`, um eine zweite Runde zu senden und den Resume-Flow zu validieren.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0`, um die Claude Code CLI MCP-Konfiguration aktiviert zu lassen (standardmäßig wird die MCP-Konfiguration mit einer temporären leeren Datei deaktiviert).

Beispiel:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Empfohlene Live-Rezepte

Schmale, explizite Zulassungslisten sind am schnellsten und am wenigsten flakisch:

- Einzelnes Modell, direkt (kein Gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Einzelnes Modell, Gateway-Smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool-Calling über mehrere Anbieter:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google-Fokus (Gemini-API-Schlüssel + Antigravity):
  - Gemini (API-Schlüssel): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Hinweise:

- `google/...` verwendet die Gemini API (API-Schlüssel).
- `google-antigravity/...` verwendet die Antigravity-OAuth-Bridge (Cloud-Code-Assist-ähnlicher Agent-Endpunkt).
- `google-gemini-cli/...` verwendet die lokale Gemini-CLI auf Ihrer Maschine (separate Auth + Tooling-Eigenheiten).
- Gemini API vs. Gemini CLI:
  - API: OpenClaw ruft Googles gehostete Gemini API über HTTP auf (API-Schlüssel / Profil-Auth); das ist das, was die meisten Nutzer mit „Gemini“ meinen.
  - CLI: OpenClaw ruft ein lokales `gemini`-Binary auf; es hat eigene Authentifizierung und kann sich anders verhalten (Streaming-/Tool-Support/Versionsabweichungen).

## Live: Modellmatrix (was wir abdecken)

Es gibt keine feste „CI-Modellliste“ (Live ist Opt-in), aber dies sind die **empfohlenen** Modelle, die regelmäßig auf einer Dev-Maschine mit Schlüsseln abgedeckt werden sollten.

### Modernes Smoke-Set (Tool-Calling + Image)

Dies ist der „gängige Modelle“-Lauf, der weiterhin funktionieren soll:

- OpenAI (nicht Codex): `openai/gpt-5.2` (optional: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (optional: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (oder `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` und `google/gemini-3-flash-preview` (ältere Gemini-2.x-Modelle vermeiden)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` und `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Gateway-Smoke mit Tools + Image ausführen:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Basislinie: Tool-Calling (Read + optional Exec)

Wählen Sie mindestens eines pro Anbieterfamilie:

- OpenAI: `openai/gpt-5.2` (oder `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (oder `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (oder `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Optionale zusätzliche Abdeckung (nice to have):

- xAI: `xai/grok-4` (oder neueste verfügbare)
- Mistral: `mistral/`… (ein „tools“-fähiges Modell auswählen, das Sie aktiviert haben)
- Cerebras: `cerebras/`… (falls Sie Zugriff haben)
- LM Studio: `lmstudio/`… (lokal; Tool-Calling hängt vom API-Modus ab)

### Vision: Image-Senden (Anhang → multimodale Nachricht)

Nehmen Sie mindestens ein bildfähiges Modell in `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI bildfähige Varianten usw.) auf, um die Image-Probe auszuführen.

### Aggregatoren / alternative Gateways

Wenn Sie entsprechende Schlüssel aktiviert haben, unterstützen wir Tests auch über:

- OpenRouter: `openrouter/...` (Hunderte Modelle; verwenden Sie `openclaw models scan`, um Tool- und Image-fähige Kandidaten zu finden)
- OpenCode Zen: `opencode/...` (Auth über `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Weitere Anbieter, die Sie in die Live-Matrix aufnehmen können (falls Sie Zugangsdaten/Konfiguration haben):

- Integriert: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Über `models.providers` (benutzerdefinierte Endpunkte): `minimax` (Cloud/API) sowie jeder OpenAI-/Anthropic-kompatible Proxy (LM Studio, vLLM, LiteLLM usw.)

Tipp: Versuchen Sie nicht, „alle Modelle“ in Dokus fest zu codieren. Die maßgebliche Liste ist das, was `discoverModels(...)` auf Ihrer Maschine zurückgibt, plus die verfügbaren Schlüssel.

## Zugangsdaten (niemals committen)

Live-Tests finden Zugangsdaten auf die gleiche Weise wie die CLI. Praktische Konsequenzen:

- Wenn die CLI funktioniert, sollten Live-Tests dieselben Schlüssel finden.

- Wenn ein Live-Test „keine Zugangsdaten“ meldet, debuggen Sie genauso wie bei `openclaw models list` / Modellauswahl.

- Profil-Store: `~/.openclaw/credentials/` (bevorzugt; das ist mit „Profil-Schlüssel“ in den Tests gemeint)

- Konfiguration: `~/.openclaw/openclaw.json` (oder `OPENCLAW_CONFIG_PATH`)

Wenn Sie sich auf Env-Schlüssel verlassen wollen (z. B. in Ihrer `~/.profile` exportiert), führen Sie lokale Tests nach `source ~/.profile` aus oder verwenden Sie die Docker-Runner unten (sie können `~/.profile` in den Container mounten).

## Deepgram Live (Audio-Transkription)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Aktivieren: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker-Runner (optionale „funktioniert unter Linux“-Checks)

Diese führen `pnpm test:live` innerhalb des Repo-Docker-Images aus, mounten Ihr lokales Konfigurationsverzeichnis und den Workspace (und sourcen `~/.profile`, falls gemountet):

- Direkte Modelle: `pnpm test:docker:live-models` (Skript: `scripts/test-live-models-docker.sh`)
- Gateway + Dev-Agent: `pnpm test:docker:live-gateway` (Skript: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding-Assistent (TTY, vollständiges Scaffolding): `pnpm test:docker:onboard` (Skript: `scripts/e2e/onboard-docker.sh`)
- Gateway-Netzwerk (zwei Container, WS-Auth + Health): `pnpm test:docker:gateway-network` (Skript: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (Custom-Extension-Laden + Registry-Smoke): `pnpm test:docker:plugins` (Skript: `scripts/e2e/plugins-docker.sh`)

Nützliche env vars:

- `OPENCLAW_CONFIG_DIR=...` (Standard: `~/.openclaw`) gemountet nach `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (Standard: `~/.openclaw/workspace`) gemountet nach `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (Standard: `~/.profile`) gemountet nach `/home/node/.profile` und vor dem Ausführen der Tests gesourct
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` zur Eingrenzung des Laufs
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`, um sicherzustellen, dass Zugangsdaten aus dem Profil-Store stammen (nicht aus Env)

## Docs-Sanity

Führen Sie nach Doku-Änderungen die Docs-Checks aus: `pnpm docs:list`.

## Offline-Regression (CI-sicher)

Dies sind „echte Pipeline“-Regressionen ohne reale Anbieter:

- Gateway-Tool-Calling (Mock-OpenAI, echtes Gateway + Agent-Loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway-Assistent (WS `wizard.start`/`wizard.next`, schreibt Konfiguration + Auth erzwungen): `src/gateway/gateway.wizard.e2e.test.ts`

## Agent-Zuverlässigkeits-Evals (Skills)

Wir haben bereits einige CI-sichere Tests, die sich wie „Agent-Zuverlässigkeits-Evals“ verhalten:

- Mock-Tool-Calling durch den echten Gateway- + Agent-Loop (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- End-to-End-Assistenten-Flows, die Sitzungsverdrahtung und Konfigurationseffekte validieren (`src/gateway/gateway.wizard.e2e.test.ts`).

Was für Skills noch fehlt (siehe [Skills](/tools/skills)):

- **Entscheidungsfindung:** Wenn Skills im Prompt gelistet sind, wählt der Agent den richtigen Skill (oder vermeidet irrelevante)?
- **Compliance:** Liest der Agent `SKILL.md` vor der Nutzung und befolgt erforderliche Schritte/Argumente?
- **Workflow-Verträge:** Mehrzügige Szenarien, die Tool-Reihenfolge, Sitzungsverlauf-Übernahme und Sandbox-Grenzen prüfen.

Zukünftige Evals sollten zunächst deterministisch bleiben:

- Ein Szenario-Runner mit Mock-Anbietern, um Tool-Calls + Reihenfolge, Skill-Datei-Lesungen und Sitzungsverdrahtung zu prüfen.
- Eine kleine Suite skill-fokussierter Szenarien (verwenden vs. vermeiden, Gating, Prompt-Injection).
- Optionale Live-Evals (Opt-in, env-gated) erst, nachdem die CI-sichere Suite vorhanden ist.

## Regressionen hinzufügen (Leitfaden)

Wenn Sie ein in Live entdecktes Anbieter-/Modellproblem beheben:

- Fügen Sie, wenn möglich, eine CI-sichere Regression hinzu (Anbieter mocken/stubben oder die exakte Request-Form-Transformation erfassen)
- Wenn es inhärent nur live ist (Rate Limits, Auth-Richtlinien), halten Sie den Live-Test eng und opt-in über Env-Variablen
- Bevorzugen Sie die kleinste Ebene, die den Bug einfängt:
  - Anbieter-Request-Konvertierungs-/Replay-Bug → Direkt-Modelle-Test
  - Gateway-Sitzungs-/Verlaufs-/Tool-Pipeline-Bug → Gateway-Live-Smoke oder CI-sicherer Gateway-Mock-Test
