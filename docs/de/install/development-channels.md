---
summary: "Stabile, Beta- und Dev-Kanäle: Semantik, Wechsel und Tagging"
read_when:
  - Sie möchten zwischen Stable/Beta/Dev wechseln
  - Sie taggen oder veröffentlichen Vorabversionen
title: "Entwicklungskanäle"
---

# Entwicklungskanäle

Zuletzt aktualisiert: 2026-01-21

OpenClaw liefert drei Update-Kanäle aus:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (Builds in der Testphase).
- **dev**: beweglicher Head von `main` (git). npm dist-tag: `dev` (bei Veröffentlichung).

Wir liefern Builds in **beta**, testen sie und **befördern anschließend einen geprüften Build zu `latest`**,
ohne die Versionsnummer zu ändern — dist-tags sind die maßgebliche Quelle für npm-Installationen.

## Kanäle wechseln

Git-Checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` checken das neueste passende Tag aus (oft dasselbe Tag).
- `dev` wechselt zu `main` und rebased auf den Upstream.

Globale npm/pnpm-Installation:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Dies aktualisiert über das entsprechende npm dist-tag (`latest`, `beta`, `dev`).

Wenn Sie **explizit** mit `--channel` den Kanal wechseln, richtet OpenClaw auch
die Installationsmethode aus:

- `dev` stellt einen Git-Checkout sicher (Standard `~/openclaw`, überschreibbar mit `OPENCLAW_GIT_DIR`),
  aktualisiert ihn und installiert die globale CLI aus diesem Checkout.
- `stable`/`beta` installiert aus npm unter Verwendung des passenden dist-tags.

Tipp: Wenn Sie Stable und Dev parallel nutzen möchten, halten Sie zwei Klone vor und verweisen Sie Ihr Gateway auf den stabilen.

## Plugins und Kanäle

Wenn Sie mit `openclaw update` den Kanal wechseln, synchronisiert OpenClaw auch die Plugin-Quellen:

- `dev` bevorzugt gebündelte Plugins aus dem Git-Checkout.
- `stable` und `beta` stellen per npm installierte Plugin-Pakete wieder her.

## Best Practices für das Tagging

- Taggen Sie Releases, auf denen Git-Checkouts landen sollen (`vYYYY.M.D` oder `vYYYY.M.D-<patch>`).
- Halten Sie Tags unveränderlich: Verschieben oder wiederverwenden Sie ein Tag niemals.
- npm dist-tags bleiben die maßgebliche Quelle für npm-Installationen:
  - `latest` → stable
  - `beta` → Kandidaten-Build
  - `dev` → Main-Snapshot (optional)

## Verfügbarkeit der macOS-App

Beta- und Dev-Builds enthalten möglicherweise **keine** macOS-App-Veröffentlichung. Das ist in Ordnung:

- Das Git-Tag und das npm dist-tag können dennoch veröffentlicht werden.
- Weisen Sie in den Release Notes oder im Changelog auf „kein macOS-Build für diese Beta“ hin.
