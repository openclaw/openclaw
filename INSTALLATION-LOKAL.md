# Lokale Installation von Activi

**Stand:** 2026-02-23  
**Unterstützte Sprachen:** English (Default), Deutsch, Bosanski, 简体中文, 繁體中文, Português

Das Paket `activi` existiert noch **nicht auf npm** (Rebranding noch nicht vollständig abgeschlossen). Du musst es **von Source** installieren.

---

## Schnellstart (du bist bereits im Projekt-Verzeichnis)

```bash
# 1. Dependencies installieren
pnpm install

# 2. UI bauen
pnpm ui:build

# 3. Projekt bauen
pnpm build

# 4. CLI verwenden (IM PROJEKT-VERZEICHNIS)
node activi.mjs onboard --install-daemon
node activi.mjs gateway --port 18789
node activi.mjs dashboard
```

**Oder mit pnpm (IM PROJEKT-VERZEICHNIS):**

```bash
cd /Users/dsselmanovic/openclaw
pnpm activi onboard --install-daemon
pnpm activi gateway --port 18789
pnpm activi dashboard
```

---

## Schritt-für-Schritt

### Schritt 1: Dependencies installieren

```bash
cd /Users/dsselmanovic/openclaw
pnpm install
```

**Falls `pnpm` nicht installiert ist:**

```bash
# pnpm installieren
npm install -g pnpm

# Oder mit npm arbeiten (langsamer)
npm install
```

### Schritt 2: UI bauen

```bash
pnpm ui:build
```

**Was passiert:**
- Installiert UI-Dependencies automatisch
- Baut die Web-UI (`ui/dist/`)
- Erstellt die Logo-Dateien

### Schritt 3: Projekt bauen

```bash
pnpm build
```

**Was passiert:**
- Kompiliert TypeScript → JavaScript (`dist/`)
- Erstellt die CLI (`activi.mjs`)

### Schritt 4: CLI verwenden

**Option A: Direkt mit Node (empfohlen für jetzt)**

```bash
# Im Projekt-Verzeichnis
cd /Users/dsselmanovic/openclaw

# CLI verwenden
node activi.mjs --version
node activi.mjs onboard --install-daemon
node activi.mjs gateway --port 18789
node activi.mjs dashboard
```

**Option B: Mit pnpm (nur im Projekt-Verzeichnis)**

```bash
cd /Users/dsselmanovic/openclaw
pnpm activi --version
pnpm activi onboard --install-daemon
pnpm activi gateway --port 18789
```

**Option C: Global verlinken (nach pnpm setup)**

```bash
# 1. pnpm setup ausführen (falls noch nicht gemacht)
pnpm setup

# 2. Shell neu starten oder:
source ~/.zshrc

# 3. Global verlinken
cd /Users/dsselmanovic/openclaw
pnpm link --global

# 4. Jetzt überall verfügbar:
activi --version
activi onboard --install-daemon
```

### Schritt 5: Setup-Wizard starten

```bash
# Im Projekt-Verzeichnis
cd /Users/dsselmanovic/openclaw
node activi.mjs onboard --install-daemon

# Oder mit pnpm
pnpm activi onboard --install-daemon
```

**Der Wizard:**
- Konfiguriert Gateway
- Erstellt Workspace
- Richtet Agents ein
- Installiert Gateway als Service

### Schritt 6: Gateway starten

**Wenn Service installiert:**

```bash
# Status prüfen
node activi.mjs gateway status

# Gateway sollte automatisch laufen
```

**Oder manuell starten:**

```bash
node activi.mjs gateway --port 18789 --verbose
```

### Schritt 7: Dashboard öffnen

```bash
node activi.mjs dashboard
```

**Oder im Browser:**

```
http://127.0.0.1:18789/
```

---

## Entwicklung (mit Auto-Reload)

Für Entwicklung mit automatischem Neuladen:

```bash
# Gateway im Watch-Modus
pnpm gateway:watch
```

**Was passiert:**
- TypeScript wird automatisch kompiliert
- Gateway startet neu bei Änderungen
- Perfekt für Entwicklung

---

## Troubleshooting

### "pnpm: command not found"

```bash
# pnpm installieren
npm install -g pnpm

# Oder mit npm arbeiten
npm install
npm run ui:build
npm run build
```

### "Command activi not found"

**Du bist nicht im Projekt-Verzeichnis!**

```bash
# Wechsle ins Projekt-Verzeichnis
cd /Users/dsselmanovic/openclaw

# Dann funktioniert es:
node activi.mjs --version
# oder
pnpm activi --version
```

### "Node version too old"

```bash
# Node-Version prüfen
node --version

# Sollte ≥22 sein
# Falls nicht: Node aktualisieren
```

### "pnpm link --global" funktioniert nicht

```bash
# 1. pnpm setup ausführen
pnpm setup

# 2. Shell neu starten oder:
source ~/.zshrc

# 3. Nochmal versuchen
cd /Users/dsselmanovic/openclaw
pnpm link --global
```

### Logo-Datei prüfen

Nach dem Build sollte das Logo verfügbar sein:

```bash
# Logo-Datei prüfen
ls -la ui/public/favicon.svg

# Im Browser öffnen (nach Gateway-Start)
open http://127.0.0.1:18789/
```

---

## Sprachunterstützung

Activi unterstützt **6 Sprachen**:

- 🇬🇧 **English** (Default)
- 🇩🇪 **Deutsch**
- 🇧🇦 **Bosanski**
- 🇨🇳 **简体中文** (Simplified Chinese)
- 🇹🇼 **繁體中文** (Traditional Chinese)
- 🇧🇷 **Português** (Brazilian Portuguese)

### Sprache im Dashboard ändern

1. Öffne das **Dashboard**: `node activi.mjs dashboard`
2. Gehe zu **Overview** → **Gateway Access**
3. Wähle deine Sprache im **Language** Dropdown
4. Die Auswahl wird automatisch gespeichert

### Automatische Spracherkennung

Beim ersten Start erkennt Activi automatisch deine Browser-Sprache:
- `de` → Deutsch
- `bs`, `hr`, `sr` → Bosanski
- `zh-CN` → 简体中文
- `zh-TW`, `zh-HK` → 繁體中文
- `pt-BR` → Português
- Sonst → **English** (Default)

## Nächste Schritte

Nach erfolgreicher Installation:

1. ✅ **Gateway läuft** → `node activi.mjs status`
2. ✅ **Dashboard öffnen** → `node activi.mjs dashboard`
3. ✅ **Sprache wählen** → Overview → Gateway Access → Language
4. ✅ **Ersten Chat starten** → Im Dashboard chatten
5. ✅ **Channels verbinden** → `node activi.mjs channels login`

---

## Zusammenfassung

**Für lokale Entwicklung (OHNE globales Linking):**

```bash
cd /Users/dsselmanovic/openclaw
pnpm install
pnpm ui:build
pnpm build
node activi.mjs onboard --install-daemon
node activi.mjs dashboard
```

**WICHTIG:** Du musst **immer im Projekt-Verzeichnis** sein, wenn du `node activi.mjs` oder `pnpm activi` verwendest!

**Fertig!** 🎉
