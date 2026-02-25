# Projekt-Analyse: Activi

## 1. Projekt-Übersicht

- **Technologie-Stack:** 
  - TypeScript/Node.js (ESM)
  - Swift (iOS/macOS Apps)
  - Kotlin (Android App)
  - React/Lit (Web UI)
  - Express.js (Gateway Server)
  - Playwright (Browser Automation)
  - SQLite + sqlite-vec (Vector Database)
  - Redis (optional, für Pub/Sub)

- **Hauptfunktionalität:** 
  Multi-Channel AI Gateway, der WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams und weitere Messaging-Plattformen mit AI-Coding-Agenten verbindet. Self-hosted Gateway-Prozess mit nativen Apps für iOS, macOS und Android.

- **Architektur:** 
  Modulare Architektur mit Gateway (Control Plane), Agent Workspaces, Channel-Integrations, Plugin-System, Skills-System. Multi-Agent-Support mit Session-Management und Memory-System.

## 2. Branding-Analyse

### Aktuelle Branding-Elemente

- **App-Name:** 
  - CLI/Package: `activi` (gefunden in: `package.json` Zeile 2)
  - Produktname: `Activi` (gefunden in: `README.md`, `docs/docs.json`, `apps/*/Info.plist`)
  - Display Name iOS/macOS: `Activi` (gefunden in: `apps/ios/Sources/Info.plist` Zeile 8, `apps/macos/Sources/Activi/Resources/Info.plist` Zeile 14)

- **Logo-Dateien:** 
  - `docs/assets/pixel-lobster.svg` (Hauptlogo, verwendet in Mintlify-Docs)
  - `docs/assets/activi-logo-text.png` / `docs/assets/activi-logo-text-dark.png` (README)
  - `ui/public/favicon.svg` (Web UI Favicon)
  - App Icons: iOS/macOS/Android Assets (nicht im Repo, aber referenziert)

- **Farben:** 
  - Primary: `#FF5A36` (gefunden in: `docs/docs.json` Zeile 23)
  - Light: `#FF8A6B` (gefunden in: `docs/docs.json` Zeile 25)
  - Dark: `#FF5A36` (gefunden in: `docs/docs.json` Zeile 24)
  - UI Accent Color: Konfigurierbar via `config.ui.seamColor` (gefunden in: `src/config/types.activi.ts` Zeile 70)

- **Domain-URLs:** 
  - `activi.ai` (Hauptdomain, Installer-URL)
  - `docs.activi.ai` (Dokumentation)
  - `github.com/activi/activi` (Repository)
  - `github.com/activi/activi/releases` (Releases)
  - `discord.gg/activi` (Community)

- **Package-Namen:** 
  - npm: `activi` (gefunden in: `package.json` Zeile 2)
  - iOS Bundle IDs: 
    - `ai.activi.ios` (Haupt-App, gefunden in: `apps/ios/Sources/Info.plist` Zeile 14)
    - `ai.activi.ios.share` (Share Extension)
    - `ai.activi.ios.watchkitapp` (Watch App)
    - `ai.activi.ios.watchkitapp.extension` (Watch Extension)
  - macOS Bundle ID: `ai.activi.mac` (gefunden in: `apps/macos/Sources/Activi/Resources/Info.plist` Zeile 10)
  - Android: 
    - Namespace: `ai.activi.android` (gefunden in: `apps/android/app/build.gradle.kts` Zeile 11)
    - Application ID: `ai.activi.android` (gefunden in: `apps/android/app/build.gradle.kts` Zeile 21)
  - Kotlin Packages: `ai.activi.android.*` (gefunden in: `apps/android/app/src/main/java/ai/activi/android/**`)

- **Repository-Name:** 
  - GitHub: `activi/activi` (gefunden in: `package.json` Zeile 14, `docs/docs.json` Zeile 39)

- **Meta-Tags:** 
  - Mintlify Docs: `name: "Activi"` (gefunden in: `docs/docs.json` Zeile 3)
  - GitHub Links in Navbar (gefunden in: `docs/docs.json` Zeile 36-46)

- **User-Facing-Text:** 
  - README: "Activi — Personal AI Assistant"
  - Beschreibungen in `docs/docs.json` Zeile 4
  - Permission Descriptions in Info.plist Dateien (z.B. "Activi can capture photos...")

### Rebranding-Plan

- **Zentrale Konfiguration:** 
  - **Teilweise zentralisiert:** 
    - `docs/docs.json` (Mintlify Branding)
    - `src/config/types.activi.ts` (UI-Branding: `ui.seamColor`, `ui.assistant.name/avatar`)
    - `package.json` (npm Package-Name)
  - **Nicht zentralisiert:** 
    - Bundle IDs in Info.plist Dateien (iOS/macOS)
    - Android Package-Namen in `build.gradle.kts`
    - Kotlin Package-Namen im Code
    - Domain-URLs in verschiedenen Dateien (hardcodiert)

- **Zu ändernde Dateien:** 
  1. **Package/CLI:**
     - `package.json` (Zeile 2: `name`, Zeile 6: `homepage`, Zeile 14: `repository.url`)
     - `activi.mjs` (CLI Entry Point)
  
  2. **Dokumentation:**
     - `docs/docs.json` (Zeile 3: `name`, Zeile 9-11: `logo`, Zeile 21: `favicon`, Zeile 22-25: `colors`, Zeile 39: GitHub Links)
     - `README.md` (Zeile 1: Titel, Zeile 5-6: Logo-Links, Zeile 21: Produktname, Zeile 26: Links)
     - `CHANGELOG.md` (Produktname-Referenzen)
     - Alle Markdown-Dateien in `docs/` mit Domain-Referenzen
  
  3. **iOS:**
     - `apps/ios/Sources/Info.plist` (Zeile 8: `CFBundleDisplayName`, Zeile 14: `CFBundleIdentifier`, Zeile 27: URL Scheme)
     - `apps/ios/WatchApp/Info.plist`
     - `apps/ios/WatchExtension/Info.plist`
     - `apps/ios/ShareExtension/Info.plist`
     - `apps/ios/Tests/Info.plist`
     - `apps/ios/Config/Signing.xcconfig` (Zeile 4-6: Bundle IDs)
     - `apps/ios/Signing.xcconfig` (Zeile 8-11: Bundle IDs)
     - `apps/ios/project.yml` (Bundle IDs, Display Names)
     - Alle Swift-Dateien mit `ai.activi.ios` Referenzen
  
  4. **macOS:**
     - `apps/macos/Sources/Activi/Resources/Info.plist` (Zeile 10: `CFBundleIdentifier`, Zeile 14: `CFBundleName`, Zeile 27: URL Scheme)
     - `apps/macos/Sources/Activi/Constants.swift` (Zeile 5-6: LaunchAgent Labels)
     - Alle Swift-Dateien mit `ai.activi.mac` Referenzen
  
  5. **Android:**
     - `apps/android/app/build.gradle.kts` (Zeile 11: `namespace`, Zeile 21: `applicationId`)
     - Alle Kotlin-Dateien in `apps/android/app/src/main/java/ai/activi/android/**` (Package-Namen)
     - `apps/android/app/proguard-rules.pro` (Zeile 2: Package-Name)
  
  6. **Code-Referenzen:**
     - `src/config/types.activi.ts` (Zeile 30: `lastTouchedVersion` Kommentar, Zeile 70: `seamColor` Kommentar)
     - `src/channels/plugins/onboarding/telegram.ts` (Zeile 35, 48: Domain-URLs)
     - `src/commands/configure.wizard.ts` (Zeile 78, 141: Domain-URLs)
     - Alle Dateien mit `activi.ai` oder `docs.activi.ai` Referenzen
  
  7. **Assets:**
     - `docs/assets/pixel-lobster.svg` (Logo ersetzen)
     - `docs/assets/activi-logo-text.png` / `activi-logo-text-dark.png` (README Logos)
     - `ui/public/favicon.svg` (Web UI Favicon)
     - App Icons (iOS/macOS/Android Asset-Kataloge)

- **Schwierigkeitsgrad:** **Schwer**
  - Viele Dateien betroffen (50+)
  - Bundle IDs erfordern App Store/Play Store Updates
  - Domain-URLs teilweise hardcodiert
  - Package-Namen in Kotlin-Code erfordern Refactoring

- **Empfohlene Vorgehensweise:** 
  1. Zentrale Branding-Konfiguration erstellen (`src/config/branding.ts`)
  2. Script erstellen zum Finden aller Branding-Referenzen (`scripts/find-branding-references.ts`)
  3. Schrittweise Migration:
     - Zuerst: Package-Name, Domains, Docs
     - Dann: Bundle IDs (erfordert neue App Store-Listings)
     - Zuletzt: Code-Refactoring (Package-Namen in Kotlin)
  4. Tests nach jedem Schritt durchführen
  5. Dokumentation aktualisieren

## 3. Update-Mechanismus-Analyse

### Aktuelle Update-Implementierung

- **Update-Server:** 
  - **Keine hardcodierte Update-Server-URL!** ✅
  - npm-basiert: Nutzt npm registry (`npm view activi version`)
  - git-basiert: Nutzt `git pull` für dev channel
  - Installer-Script: `https://activi.ai/install.sh` (gefunden in: `docs/install/updating.md`)

- **Update-Check:** 
  - `src/infra/update-check.ts` (Zeile 362-402: `checkUpdateStatus()`)
  - `src/infra/update-startup.ts` (Zeile 105-205: `runGatewayUpdateCheck()`)
  - `src/cli/update-cli/update-command.ts` (Zeile 570-783: `updateCommand()`)
  - Gateway-Methode: `src/gateway/server-methods/update.ts` (Zeile 18-134: `update.run` Handler)

- **Version-Management:** 
  - SemVer-ähnlich: `YYYY.M.D` Format (z.B. `2026.2.22`)
  - npm dist-tags: `latest`, `beta`, `dev`
  - Git tags: `vYYYY.M.D`, `vYYYY.M.D-beta.N`
  - Version in `package.json` Zeile 3
  - iOS: `CFBundleShortVersionString` / `CFBundleVersion` in Info.plist
  - Android: `versionName` / `versionCode` in `build.gradle.kts`

- **Update-Channels:** 
  - `stable`: npm `latest` tag
  - `beta`: npm `beta` tag
  - `dev`: git checkout mit `git pull`
  - Konfigurierbar via `config.update.channel` (gefunden in: `src/config/types.activi.ts` Zeile 63)

- **Update-Konfiguration:**
  - `config.update.channel`: `"stable" | "beta" | "dev"` (gefunden in: `src/config/types.activi.ts` Zeile 63)
  - `config.update.checkOnStart`: `boolean` (gefunden in: `src/config/types.activi.ts` Zeile 65)
  - Nutzerkonfiguration: `~/.activi/activi.json`

### Update-Umleitung-Plan

- **Konfigurierbare Update-URL:** **JA** ✅
  - npm registry wird verwendet (keine hardcodierte URL)
  - Git remote kann geändert werden (standard: `origin`)
  - Installer-Script-URL ist hardcodiert in Docs, aber Script selbst kann angepasst werden

- **Umleitung-Mechanismus:** 
  - **npm-basiert:** 
    - Aktuell: `npm view activi version` (nutzt npm registry)
    - Umleitung möglich via: `npm config set registry <custom-registry>` oder `.npmrc`
    - Oder: Environment-Variable für custom registry
  - **git-basiert:** 
    - Aktuell: `git pull` von `origin`
    - Umleitung möglich via: `git remote set-url origin <new-url>`
  - **Installer-Script:**
    - Hardcodiert in Docs (`https://activi.ai/install.sh`)
    - Script selbst kann auf anderen Server gehostet werden

- **Schwierigkeitsgrad:** **Einfach**
  - Update-Mechanismus ist bereits flexibel
  - Keine hardcodierten Update-Server-URLs im Code
  - npm registry und git remote sind konfigurierbar

- **Empfohlene Vorgehensweise:** 
  1. **Für npm-basierte Updates:**
     - `.npmrc` Datei erstellen mit `registry=<custom-registry-url>`
     - Oder: Environment-Variable `NPM_CONFIG_REGISTRY` setzen
  2. **Für git-basierte Updates:**
     - `git remote set-url origin <new-git-url>` ausführen
  3. **Für Installer-Script:**
     - Script auf eigenen Server hosten
     - Docs aktualisieren mit neuer URL
  4. **Optional:** Config-Option hinzufügen für custom npm registry:
     ```typescript
     update?: {
       channel?: "stable" | "beta" | "dev";
       checkOnStart?: boolean;
       registry?: string; // Neu: Custom npm registry URL
     }
     ```

## 4. Stärken

- **Architektur-Stärken:**
  - Modulare Architektur mit klarer Trennung (Gateway, Channels, Agents, Tools)
  - Plugin-System für Erweiterungen
  - Skills-System für Agent-Funktionalität
  - TypeScript mit strikter Typisierung
  - Multi-Platform Support (iOS, macOS, Android, Linux, Windows)
  - Self-hosted Architektur (Datenschutz)

- **Feature-Stärken:**
  - Multi-Channel-Support (WhatsApp, Telegram, Discord, etc.)
  - Native Apps für alle Hauptplattformen
  - Voice Wake auf macOS/iOS/Android
  - Canvas-Rendering für visuelle Interaktion
  - Multi-Agent-Support mit Session-Management
  - Vector Database für Memory/Semantic Search
  - Extensible via Plugins und Skills

- **Code-Qualität:**
  - Umfangreiche Tests (Vitest, E2E, Live Tests)
  - Linting und Formatting (Oxlint, Oxfmt)
  - TypeScript Strict Mode
  - Code-Dokumentation vorhanden

- **Update-Mechanismus:**
  - ✅ Keine hardcodierten Update-URLs
  - Flexibel konfigurierbar (npm registry, git remote)
  - Channel-System (stable/beta/dev)
  - Automatische Update-Checks optional

## 5. Schwächen

- **Technische Schwächen:**
  - Branding nicht vollständig zentralisiert (viele hardcodierte Stellen)
  - Domain-URLs teilweise hardcodiert in Code und Docs
  - Bundle IDs erfordern App Store-Updates für Rebranding
  - Package-Namen in Kotlin-Code erfordern Refactoring

- **Architektur-Schwächen:**
  - Keine zentrale Branding-Konfiguration
  - Installer-Script-URL hardcodiert in Dokumentation
  - Keine Config-Option für custom npm registry (muss via .npmrc)

- **Rebranding-Schwierigkeiten:**
  - Viele Dateien müssen geändert werden (50+)
  - Bundle IDs ändern erfordert neue App Store-Listings
  - Kotlin Package-Namen ändern erfordert umfangreiches Refactoring

## 6. Profit-Optimierungsmöglichkeiten

- **Monetarisierung:**
  - Aktuell: Open Source (MIT License)
  - Potenzial: Enterprise-Features (Multi-Tenant, SSO, Advanced Analytics)
  - Potenzial: Hosted Gateway-Service (SaaS-Angebot)
  - Potenzial: Premium Skills/Plugins

- **Kosten-Optimierung:**
  - Vector Database: sqlite-vec ist effizient (lokale DB)
  - Self-hosted reduziert Cloud-Kosten
  - Caching-Strategien für API-Calls vorhanden
  - Optional Redis für Pub/Sub (nicht zwingend erforderlich)

## 7. Erweiterungsmöglichkeiten

- **Feature-Erweiterungen:**
  - Weitere Channel-Integrations (z.B. LinkedIn, Twitter/X)
  - Enterprise-Features (Multi-Tenant, SSO)
  - Advanced Analytics Dashboard
  - Webhook-System für externe Integrationen
  - API für Third-Party-Apps

- **Technische Erweiterungen:**
  - Zentrale Branding-Konfiguration (`src/config/branding.ts`)
  - Config-Option für custom npm registry
  - Branding-Theme-System erweitern
  - Internationalisierung (i18n) für mehr Sprachen

## 8. Rebranding-Checkliste

- [ ] Alle Branding-Referenzen identifiziert ✅ (siehe Abschnitt 2)
- [ ] Zentrale Konfiguration erstellt (TODO: `src/config/branding.ts`)
- [ ] Update-Umleitung implementiert ✅ (bereits möglich via npm registry/git remote)
- [ ] Script zum Finden aller Referenzen erstellt (TODO: `scripts/find-branding-references.ts`)
- [ ] Package-Name geändert (`package.json`)
- [ ] Domains geändert (Docs, Code-Referenzen)
- [ ] Bundle IDs geändert (iOS/macOS/Android)
- [ ] Kotlin Package-Namen refactored
- [ ] Logo-Assets ersetzt
- [ ] Tests für Rebranding durchgeführt
- [ ] Dokumentation aktualisiert
- [ ] App Store-Listings aktualisiert (neue Bundle IDs)

## Zusammenfassung

**Rebranding-Fähigkeit:** ⚠️ **Mittel bis Schwer**
- Viele Dateien betroffen (50+)
- Bundle IDs erfordern App Store-Updates
- Domain-URLs teilweise hardcodiert
- Keine zentrale Branding-Konfiguration

**Update-Umleitung:** ✅ **Einfach**
- Keine hardcodierten Update-Server-URLs
- npm registry konfigurierbar via `.npmrc` oder Environment-Variable
- git remote konfigurierbar via `git remote set-url`
- Installer-Script kann auf anderen Server gehostet werden

**Empfehlung:** 
Zentrale Branding-Konfiguration erstellen (`src/config/branding.ts`) und schrittweise Migration durchführen. Update-Mechanismus ist bereits flexibel und benötigt keine Änderungen für Umleitung.
