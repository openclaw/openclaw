# BusinessClaw (BCL) - Vision & Alltime Goal

**Version:** 2.2  
**Date:** 2026-02-28  
**Status:** Read-Only Planning Mode Exited

---

## Architektur-Hinweis

> **WICHTIG:** BCL ist eine **OpenClaw Extension** und befindet sich unter `openclaw/extensions/bcl-hustle/`. Es ist KEIN eigenständiges Projekt, sondern ein integraler Bestandteil des OpenClaw-Ökosystems.

---

## Alltime Goal

> **Ein selbstständiges, selbstverbesserndes System zu erschaffen, das kontinuierlich online Geschäftsmöglichkeiten identifiziert, validiert, implementiert und monetarisiert - mit dem Ziel, vollständig passives Einkommen zu generieren und dabei aus jedem Erfolg und Misserfolg lernt.**

---

## Vision Statement

**BusinessClaw (BCL)** ist ein vollständig autonomer, 24/7 operierender AI-Business-Agent, der eigenständig Einkommensströme generiert, verwaltet und skaliert - ohne menschliches Zutun, ohne Budget, ohne Limits. BCL nutzt lokale Ressourcen (CPU, GPU, Storage) wenn verfügbar, arbeitet aber zuverlässig im "Best Effort" Modus ohne garantierte Uptime.

---

## Kernprinzipien

### 1. Absolute Autonomie

- **24/7 Betrieb:** Das System läuft rund um die Uhr ohne menschliches Zutun
- **Selbstentscheidend:** BCL trifft alle operativen Entscheidungen selbst
- **Selbstbauend:** BCL entwickelt eigene Tools und Features wenn benötigt
- **Kein Mikromanagement:** Der Nutzer wird nur bei kritischen Punkten (Geld-Ausgaben, wichtige Meilensteine) kontaktiert

### 2. Zero-Dollar Philosophie

- **Kein Startkapital:** Alle Projekte starten mit 0$ Investition
- **API-First:** Nutzung von kostenlosen APIs und Services (Groq, GitHub, Telegram)
- **Kostenkontrolle:** Jeder Cent Ausgabe bedarf expliziter Genehmigung
- **Qualität > Geld:** Hohe Standards werden hardcodiert, nie auf Kosten der Qualität

### 3. Subagent-Architektur

- **Spezialisierung:** Jeder Subagent hat eine klar definierte Aufgabe
- **Robustheit:** Separate Prozesse für Fehlerisolation und Auto-Recovery
- **Skalierbarkeit:** Einfaches Hinzufügen neuer Agenten für neue Aufgabenbereiche
- **Multi-Model Failover:** Bei Rate-Limits (429) automatisch auf alternatives Modell wechseln

### 4. Kontinuierliches Lernen

- **Pattern Recognition:** Erfolgreiche Strategien werden identifiziert und wiederholt
- **Failure Analysis:** Misserfolge werden analysiert und vermieden
- **Competitor Learning:** Automatisierte Analyse erfolgreicher Konkurrenten
- **Brain.md:** Persistentes Gedächtnis für langfristiges Lernen

### 5. Sicherheit & Compliance

- **Zero-Trust Security:** Security Tests auf jedem Commit
- **Dependency Management:** Automatisches Dependabot Setup
- **Multi-Wallet Safety:** BTC, ETH, Solana Support mit Volatilitäts-Warnungen
- **Receipt Tracking:** Automatische Erfassung und Verwaltung aller Belege

---

## Autonomie-Stufen

### Volle Autonomie (Selbstständige Entscheidung)

- Research & Marktanalyse
- Wettbewerbsanalyse
- Code-Building & Implementierung
- Marketing-Kampagnen
- Finanz-Tracking & Monitoring
- Test-Generierung

### Menschliches Gate erforderlich

- Partnerschafts-Verträge
- Bug Bounty Auszahlungen
- Preisänderungen mit >$500 Impact
- Bezahlte API-Genehmigungen
- Rechtsverbindliche Vereinbarungen

---

## Anti-Hallucination Anforderungen

### Confidence Scoring

- **Schwellenwert:** >85% Konfidenz erforderlich für Entscheidungen
- **Bewertungssystem:** AI-basierte Einschätzung mit transparenter Begründung
- **Fallback:** Bei <85% → Human Review erforderlich

### Multi-Source Validierung

- **Mindestens 3 unabhängige Quellen** für alle wichtigen Entscheidungen
- **Quellen-Diversität:** Verschiedene Plattformen und Datentypen
- **Widerspruchs-Handling:** Bei widersprüchlichen Informationen → Escalation

### Human Review Gate

- **Automatisch bei:** >$500 finanzieller Impact
- **Automatisch bei:** Strategieänderungen
- **Automatisch bei:** Neue Markt-Eintritte

### Audit Trail

- **Vollständige Protokollierung** aller Predictions und Entscheidungen
- **Zeitstempel:** Jede Aktion mit exaktem Zeitpunkt
- **Begründung:** Dokumentation der Entscheidungsgrundlage
- **Rückverfolgbarkeit:** Alle Quellen und Referenzen speichern

---

## Best Effort Uptime

Das System arbeitet im **"Best Effort" Modus** mit folgenden Charakteristiken:

- **Intermittierende Konnektivität:** Das System ist robust gegenüber temporären Ausfällen
- **Automatisches Recovery:** Bei Neustart werden alle laufenden Tasks fortgesetzt
- **Offline-Fähigkeit:** Lokale Verarbeitung priorisiert, wenn keine Verbindung verfügbar
- **Graceful Degradation:** Bei API-Ausfällen werden alternative Pfade genutzt
- **State Persistence:** Alle kritischen Daten werden sofort in SQLite/brain.md persistiert
- **Keine garantierte Verfügbarkeit:** Das System optimiert für Ressourceneffizienz, nicht für 100% Uptime

---

## Das Autonome Loop-System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         24/7 MASTER LOOP                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   06:00  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐      │
│   ──────▶│   RESEARCH   │─────▶│   COMPETITOR │─────▶│   ANALYZE    │      │
│          │   AGENT      │      │   ANALYZER   │      │   ENGINE     │      │
│          └──────────────┘      └──────────────┘      └──────┬───────┘      │
│                                                             │              │
│   09:00                                                     ▼              │
│   ──────              ┌──────────────┐               ┌──────────────┐      │
│          ┌───────────│    BUILD     │◀──────────────│   DECISION   │      │
│          │            │    AGENT     │               │   GATE       │      │
│          │            │   (KILO)     │               └──────────────┘      │
│          │            └──────┬───────┘                     ▲             │
│          │                   │                              │             │
│          │            ┌──────┴───────┐                      │             │
│          │            ▼              ▼                      │             │
│          │   ┌──────────────┐  ┌──────────────┐             │             │
│          │   │   GITHUB     │  │   SECURITY   │             │             │
│          │   │   REPO + PR  │  │   SCAN       │             │             │
│          │   └──────┬───────┘  └──────┬───────┘             │             │
│          │          │                  │                    │             │
│          │          └────────┬─────────┘                    │             │
│          │                   ▼                              │             │
│          │            ┌──────────────┐                       │             │
│          │            │    MERGE     │                       │             │
│          │            │    & DEPLOY │                       │             │
│          │            └──────┬───────┘                       │             │
│          │                   ▼                                │             │
│   14:00  │            ┌──────────────┐                         │             │
│   ──────▶│           │   MARKETING  │                         │             │
│          │           │   + FEEDBACK │                         │             │
│          │           │   ANALYZER   │                         │             │
│          │           └──────┬───────┘                         │             │
│          │                   ▼                                 │             │
│   18:00  │           ┌──────────────┐                          │             │
│   ──────▶│          │   FINANCE    │◀─────────────────────────┘             │
│          │          │   AGENT      │◀── Multi-Wallet (BTC, ETH, SOL)      │
│          │          └──────┬───────┘◀── Purchase + Receipt Tracking       │
│          │                 │                                             │
│          │                 ▼                                             │
│   20:00  │          ┌──────────────┐                                      │
│   ──────▶│          │   DAILY      │──▶ Telegram Report                   │
│          │          │   REPORT     │──▶ Health Dashboard                  │
│          │          └──────┬───────┘                                      │
│          │                 ▼                                              │
│   22:00  │          ┌──────────────┐                                      │
│   ──────▶│          │   LEARNING   │──▶ Brain.md Update                   │
│          │          │    LOOP      │                                      │
│          │          └──────────────┘                                      │
│          │                                                                 │
│   CONTINUOUS  ┌──────────────┐                                            │
│   ──────────▶ │  MILESTONE   │──▶ Call at $100, $1000, $10000...          │
│   MONITORING  │  DETECTOR    │                                            │
│               └──────────────┘                                            │
│                                                                             │
│   ON-DEMAND   ┌──────────────┐                                            │
│   ──────────▶ │  TOOL BUILD  │──▶ Prompt/Plan Output for Kilo Code        │
│               │    AGENT     │──▶ (NO direct code generation!)             │
│               └──────────────┘                                            │
│                                                                             │
│   HUMAN       ┌──────────────┐                                            │
│   ──────────▶ │   /review    │──▶ Human Override Command                  │
│   OVERRIDE    │   COMMAND    │──▶ Strategic Decision Gate                 │
│               └──────────────┘                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Komponenten

### 1. Master Orchestrator

- **Zentrale Steuerung:** Koordiniert alle Subagents
- **Scheduling:** Cron-basierte Task-Planung
- **State Management:** SQLite für Projekte, Einnahmen, Milestones
- **Decision Engine:** ROI-basierte Opportunity-Bewertung
- **Circuit Breaker:** Automatische Isolation bei Service-Ausfällen

### 2. Research Agent

- **Datenquellen:** Reddit, IndieHackers, Twitter, GitHub, Product Hunt
- **Scraping:** Automated data extraction
- **Scoring:** AI-basierte Opportunity-Bewertung (0-100)

### 3. Competitor Analyzer Agent

- **Automatische Identifikation:** Findet erfolgreiche Konkurrenten im gleichen Bereich
- **Deep Analysis:** Extrahiert Preisgestaltung, Features, Marketing-Strategien
- **Learning Engine:** Identifiziert wiederholbare Erfolgsmuster
- **Report Generation:** Aktionsableitbare Empfehlungen für BCL-Projekte

### 4. Builder Agent (Kilo Bridge)

- **Plan Mode:** Detaillierte Implementierungsplanung mit Kilo
- **Orchestrator Mode:** Code-Generierung und -Implementierung
- **Tool Building:** Entwickelt Prompts/Pläne für Kilo Code wenn neue Features benötigt werden
- **WICHTIG:** Tool Building Agent generiert KEINEN direkten Code, nur Prompts und Pläne
- **goal.md:** Speicherung des Plans für Referenz
- **GitHub Integration:** Repo-Erstellung, PRs, Reviews

### 5. Security Agent

- **Dependabot Setup:** Automatische Konfiguration für Dependency Updates
- **Commit Scanning:** Security Tests auf jedem PR-Commit
- **Vulnerability Alerts:** Benachrichtigung bei kritischen Sicherheitslücken
- **Auto-Patch:** Automatische Anwendung sicherer Patches wenn verfügbar

### 6. Marketer Agent

- **Content Creation:** Landing Pages, Social Posts, Blog-Artikel
- **Distribution:** Reddit, Twitter, Newsletter
- **SEO:** Automatische Optimierung
- **Feedback Analysis:** Kunden-Feedback automatisch analysieren und verarbeiten

### 7. Finance Agent

- **Multi-Wallet Support:** BTC, ETH, Solana Monitoring
- **Volatility Alerts:** Benachrichtigung bei extremen Kursbewegungen (z.B. BTC -50% in 3 Monaten)
- **Milestone Detection:** Automatische Erkennung von Einnahme-Meilensteinen
- **ROI Tracking:** Projektspezifische Rentabilitätsanalyse
- **Purchase Tracking:** Jede Ausgabe mit Beleg-Erfassung
- **Escalation:** Anrufe bei wichtigen Meilensteinen

### 8. Market Trend Predictor Agent

- **Trend Analysis:** Machine Learning-basierte Marktrend-Vorhersage
- **Anti-Hallucination:**
  - Confidence Scoring mit >85% Schwellenwert
  - Multi-Source Validation (mindestens 3 Quellen)
  - Human Review Gate für alle Predictions mit >$500 Impact
  - Vollständiger Audit Trail für alle Vorhersagen
- **Predictive Analytics:** Identifikation von aufkommenden Opportunitäten
- **Historical Pattern Recognition:** Analyse vergangener Marktzyklen

### 9. Test Generator Agent

- **Auto-Test Creation:** Automatische Test-Coverage Generierung
- **Coverage Requirement:** Minimum 70% Code Coverage
- **Test Types:** Unit Tests, Integration Tests, E2E Tests
- **Quality Gates:** Test-Suite muss bestehen vor jedem Merge

### 10. Comms Agent

- **Telegram Bot:** Text-Updates, Voice Messages
- **Voice Calls:** Telegram Calls bei kritischen Ereignissen
- **Escalation Levels:** Critical, High, Normal, Low
- **Anti-Spam:** Max 3 Nachrichten/Tag, nur wichtiges

### 11. Health & Monitoring Agent

- **Dashboard:** Integriert in bestehende Health-Übersicht
- **Uptime Tracking:** Überwachung aller Services
- **Resource Monitor:** CPU, GPU, Storage Nutzung lokal
- **Alert System:** Benachrichtigung bei kritischen Fehlern

### 12. Rate Limit Manager

- **Multi-Model Failover:** Bei 429 automatisch auf alternatives Modell wechseln
- **Circuit Breaker:** Service-Isolation bei wiederholten Fehlern
- **Retry Logic:** Intelligente Wiederholungsstrategien mit Backoff

---

## Technische Spezifikation

### Hardware

- **Raspberry Pi 4/5:** 24/7 Hauptsystem
- **Local Resources:** Nutzt lokale CPU, GPU, Storage wenn verfügbar
- **Best Effort Uptime:** Keine garantierte Verfügbarkeit, robustes Offline-Handling
- **Zero-API-Costs:** Nur kostenlose/kostenoptimierte APIs

### APIs

| Service    | Zweck             | Kosten         | Failover          |
| ---------- | ----------------- | -------------- | ----------------- |
| Groq       | LLM (70B Modelle) | $0 (Free Tier) | Auto-switch Model |
| GitHub     | Repos, PRs        | $0             | -                 |
| Telegram   | Bot, Voice        | $0             | -                 |
| Solana RPC | Wallet            | $0             | -                 |
| BTC RPC    | Wallet            | $0             | -                 |
| ETH RPC    | Wallet            | $0             | -                 |

### Architektur

- **Language:** TypeScript
- **Framework:** OpenClaw Extension
- **Location:** `openclaw/extensions/bcl-hustle/`
- **Database:** SQLite
- **Process Management:** Node.js child_process
- **Scheduling:** Croner
- **Security:** Dependabot, Automated Security Scanning
- **Resource Model:** Opportunistische Nutzung lokaler Ressourcen

---

## Core Values (Hardcoded)

```typescript
const BCL_CORE_VALUES = {
  // Qualität hat oberste Priorität
  quality_over_money: true,

  // Tool Building Pattern: Prompt/Plan für Kilo Code
  tool_building_pattern: "prompt_plan_for_kilo_code",

  // Anti-Hallucination aktiviert
  anti_hallucination_enabled: true,
  min_confidence_threshold: 0.85,
  human_review_required_impact: 500,

  // BCL baut eigene Tools bei Bedarf
  auto_tool_building: true,

  // Minimaler menschlicher Eingriff
  max_human_interaction: "start + revenue_cut_only",

  // Ressourcennutzung
  resource_usage: "local_cpu_gpu_storage_when_available",

  // Uptime-Modell
  uptime_model: "best_effort",

  // Kostenkontrolle
  free_tier_only: true,
  require_approval_for_spend: true,

  // Test-Anforderungen
  min_test_coverage: 0.7,

  // Sicherheitsstandards
  security_first: true,
  dependabot_enabled: true,
  security_scan_on_every_commit: true,

  // Finanzkontrolle
  track_all_purchases: true,
  require_receipts: true,
  volatility_monitoring: true,

  // Rate Limiting
  auto_model_failover: true,
  circuit_breaker_enabled: true,
};
```

---

## Meilensteine & Erfolgskriterien

### Phase 1: Foundation (Woche 1)

- [x] Extension-Struktur
- [x] Subagent-Architektur
- [x] Storage-System (SQLite + brain.md)
- [x] API-Integrationen

### Phase 2: Security & Intelligence (Woche 2)

- [ ] Dependabot automatisch konfiguriert
- [ ] Security Scanning auf jedem Commit
- [ ] Competitor Analyzer Agent implementiert
- [ ] Feedback Analysis System

### Phase 3: Multi-Chain & Finance (Woche 3-4)

- [ ] Multi-Wallet Support (BTC, ETH, Solana)
- [ ] Volatilitäts-Monitoring aktiviert
- [ ] Purchase Tracking mit Receipt-Management
- [ ] Rate Limit Failover implementiert

### Phase 4: First Dollar (Woche 5-6)

- [ ] Erste autonom generierte Einnahme
- [ ] Erstes erfolgreiches Projekt deployed
- [ ] Telegram Call bei $1

### Phase 5: Scaling (Woche 7-10)

- [ ] 3 gleichzeitige Projekte
- [ ] $100 Einnahmen (Call)
- [ ] Positive ROI nach 3 Monaten
- [ ] Tool Building Agent aktiviert (Prompt/Plan Modus)

### Phase 6: Autonomy (Woche 11-14)

- [ ] $1000 Einnahmen (Call + Celebration)
- [ ] Selbstständige Strategie-Optimierung
- [ ] 7 Tage ohne menschliches Zutun
- [ ] Health Dashboard implementiert

### Phase 7: Independence (Monat 4-6)

- [ ] $10,000 Einnahmen
- [ ] Vollständig passives Einkommen
- [ ] System finanziert sich selbst

---

## Anti-Goals (Was BCL NICHT tun wird)

- Keine illegalen Aktivitäten
- Keine Manipulation oder Täuschung
- Kein Spam oder ungewolltes Marketing
- Keine Ausgaben ohne Genehmigung
- Keine Datensammlung ohne Einwilligung
- Keine Qualitätsopfer für höhere Einnahmen
- **Keine bezahlten APIs ohne explizite Genehmigung**
- **KEINE direkte Code-Generierung durch Tool Building Agent (nur Prompts/Pläne)**

---

## Zukunftsvision

> **"Ein System, das während ich schlafe, arbeite oder lebe, kontinuierlich Wert schafft, lernt und wächst - bis zu dem Punkt, wo es nicht nur mein Leben finanziert, sondern auch neue Möglichkeiten schafft, die ich nie selbst entdeckt hätte."**

---

## Implementierung

Siehe `openclaw/extensions/bcl-hustle/` für die vollständige Implementierung.

---

**END OF SPECIFICATION**
