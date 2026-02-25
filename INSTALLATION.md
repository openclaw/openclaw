# Activi Installation Guide

**Stand:** 2026-02-23  
**Unterstützte Sprachen:** English (Default), Deutsch, Bosanski, 简体中文, 繁體中文, Português

---

## Schnellstart

### Option 1: Installer-Script (Empfohlen)

**macOS / Linux / WSL:**

```bash
curl -fsSL https://activi.ai/install.sh | bash
```

**Windows (PowerShell):**

```powershell
iwr -useb https://activi.ai/install.ps1 | iex
```

### Option 2: Von Source (Lokale Entwicklung)

```bash
# 1. Repository klonen
git clone https://github.com/activi/activi.git
cd activi

# 2. Dependencies installieren
pnpm install

# 3. UI bauen (inkl. Sprachdateien)
pnpm ui:build

# 4. Projekt bauen
pnpm build

# 5. CLI global verlinken (optional)
pnpm link --global

# 6. Onboarding starten
activi onboard --install-daemon
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

1. Öffne das **Dashboard**: `activi dashboard`
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

---

## Systemanforderungen

- **Node.js 22+** (wird automatisch installiert, falls fehlend)
- **macOS**, **Linux** oder **Windows** (WSL2 empfohlen)
- **pnpm** nur bei Source-Installation

---

## Installationsmethoden

### 1. Installer-Script (Empfohlen)

**Vorteile:**
- Automatische Node.js-Installation
- Onboarding-Wizard
- Gateway-Service-Setup

**macOS / Linux:**

```bash
curl -fsSL https://activi.ai/install.sh | bash
```

**Ohne Onboarding:**

```bash
curl -fsSL https://activi.ai/install.sh | bash -s -- --no-onboard
```

**Windows:**

```powershell
iwr -useb https://activi.ai/install.ps1 | iex
```

### 2. npm / pnpm (Global)

**npm:**

```bash
npm install -g activi@latest
activi onboard --install-daemon
```

**pnpm:**

```bash
pnpm add -g activi@latest
pnpm approve-builds -g
activi onboard --install-daemon
```

### 3. Von Source

**Für Entwickler:**

```bash
# Repository klonen
git clone https://github.com/activi/activi.git
cd activi

# Dependencies installieren
pnpm install

# UI bauen (inkl. alle Sprachdateien)
pnpm ui:build

# Projekt bauen
pnpm build

# CLI verlinken
pnpm link --global

# Onboarding
activi onboard --install-daemon
```

**Ohne globales Linking:**

```bash
# Im Projekt-Verzeichnis arbeiten
cd activi
pnpm activi --version
pnpm activi onboard --install-daemon
pnpm activi dashboard
```

---

## Nach der Installation

### Verifizierung

```bash
# Status prüfen
activi doctor

# Gateway-Status
activi status

# Dashboard öffnen
activi dashboard
```

### Erste Schritte

1. **Dashboard öffnen**: `activi dashboard`
2. **Sprache wählen**: Overview → Gateway Access → Language
3. **Channels verbinden**: `activi channels login`
4. **Ersten Agent erstellen**: Im Dashboard → Agents

---

## Gateway starten/stoppen

### Als Service (Empfohlen)

```bash
# Status
activi gateway status

# Starten
activi gateway start

# Stoppen
activi gateway stop

# Neustarten
activi gateway restart
```

### Manuell (Terminal)

```bash
# Gateway im Vordergrund starten
activi gateway --port 18789

# Mit Logs
activi gateway --port 18789 --verbose
```

---

## Update

### Installer-Script (Empfohlen)

```bash
# Einfach erneut ausführen
curl -fsSL https://activi.ai/install.sh | bash
```

### npm / pnpm

```bash
npm install -g activi@latest
# oder
pnpm add -g activi@latest

# Gateway neustarten
activi gateway restart
```

### Von Source

```bash
# Im Repository-Verzeichnis
git pull
pnpm install
pnpm ui:build
pnpm build
activi gateway restart
```

---

## Troubleshooting

### "activi: command not found"

**Problem:** PATH enthält npm global bin nicht.

**Lösung:**

```bash
# PATH prüfen
echo $PATH
npm prefix -g

# Zu Shell-Config hinzufügen (~/.zshrc oder ~/.bashrc)
export PATH="$(npm prefix -g)/bin:$PATH"

# Shell neu laden
source ~/.zshrc  # oder source ~/.bashrc
```

### "pnpm: command not found"

```bash
npm install -g pnpm
```

### "Node version too old"

```bash
# Node-Version prüfen
node --version  # Sollte ≥22 sein

# Node aktualisieren (macOS)
brew install node@22

# Node aktualisieren (Linux)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Sprache wird nicht gespeichert

**Problem:** Browser blockiert localStorage.

**Lösung:**
- Cookies erlauben
- Kein Private/Incognito-Modus
- Browser-Cache leeren

---

## Sprachdateien

Die Sprachdateien befinden sich in:

```
ui/src/i18n/locales/
├── en.ts      # English (Default)
├── de.ts      # Deutsch
├── bs.ts      # Bosanski
├── zh-CN.ts   # 简体中文
├── zh-TW.ts   # 繁體中文
└── pt-BR.ts   # Português
```

Nach `pnpm ui:build` werden diese kompiliert und im Dashboard verfügbar.

---

## Weitere Ressourcen

- **Dokumentation**: https://docs.activi.ai
- **GitHub**: https://github.com/activi/activi
- **Discord**: https://discord.gg/activi

---

## Zusammenfassung

**Schnellste Installation:**

```bash
curl -fsSL https://activi.ai/install.sh | bash
```

**Lokale Entwicklung:**

```bash
git clone https://github.com/activi/activi.git
cd activi
pnpm install
pnpm ui:build
pnpm build
pnpm link --global
activi onboard --install-daemon
activi dashboard
```

**Sprache ändern:**

Dashboard → Overview → Gateway Access → Language

---

**Fertig!** 🎉
