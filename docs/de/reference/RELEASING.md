---
summary: "Schritt-für-Schritt-Release-Checkliste für npm + macOS-App"
read_when:
  - Erstellen eines neuen npm-Releases
  - Erstellen eines neuen macOS-App-Releases
  - Überprüfen von Metadaten vor der Veröffentlichung
---

# Release-Checkliste (npm + macOS)

Verwenden Sie `pnpm` (Node 22+) aus dem Repo-Root. Halten Sie den Working Tree vor dem Taggen/Veröffentlichen sauber.

## Operator-Trigger

Wenn der Operator „release“ sagt, führen Sie sofort diese Vorabprüfung durch (keine zusätzlichen Fragen, außer wenn Sie blockiert sind):

- Lesen Sie dieses Dokument und `docs/platforms/mac/release.md`.
- Laden Sie env aus `~/.profile` und bestätigen Sie, dass `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect-Variablen gesetzt sind (SPARKLE_PRIVATE_KEY_FILE sollte sich in `~/.profile` befinden).
- Verwenden Sie bei Bedarf Sparkle-Schlüssel aus `~/Library/CloudStorage/Dropbox/Backup/Sparkle`.

1. **Version & Metadaten**

- [ ] Erhöhen Sie die `package.json`-Version (z. B. `2026.1.29`).
- [ ] Führen Sie `pnpm plugins:sync` aus, um Versionsstände der Extension-Pakete + Changelogs abzugleichen.
- [ ] Aktualisieren Sie CLI-/Versions-Strings: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) und den Baileys User Agent in [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Bestätigen Sie die Paketmetadaten (Name, Beschreibung, Repository, Keywords, Lizenz) und dass die `bin`-Zuordnung für `openclaw` auf [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) zeigt.
- [ ] Wenn sich Abhängigkeiten geändert haben, führen Sie `pnpm install` aus, damit `pnpm-lock.yaml` aktuell ist.

2. **Build & Artefakte**

- [ ] Wenn sich A2UI-Eingaben geändert haben, führen Sie `pnpm canvas:a2ui:bundle` aus und committen Sie ggf. aktualisierte [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (regeneriert `dist/`).
- [ ] Verifizieren Sie, dass das npm-Paket `files` alle erforderlichen `dist/*`-Ordner enthält (insbesondere `dist/node-host/**` und `dist/acp/**` für Headless Node + ACP CLI).
- [ ] Bestätigen Sie, dass `dist/build-info.json` existiert und den erwarteten `commit`-Hash enthält (das CLI-Banner verwendet diesen für npm-Installationen).
- [ ] Optional: `npm pack --pack-destination /tmp` nach dem Build; prüfen Sie den Tarball-Inhalt und halten Sie ihn für den GitHub-Release bereit (nicht committen).

3. **Changelog & Doku**

- [ ] Aktualisieren Sie `CHANGELOG.md` mit benutzerrelevanten Highlights (Datei bei Bedarf anlegen); halten Sie Einträge strikt absteigend nach Version.
- [ ] Stellen Sie sicher, dass README-Beispiele/Flags dem aktuellen CLI-Verhalten entsprechen (insbesondere neue Befehle oder Optionen).

4. **Validierung**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (oder `pnpm test:coverage`, wenn Sie Coverage-Ausgabe benötigen)
- [ ] `pnpm release:check` (verifiziert Inhalte von npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker-Installations-Smoke-Test, schneller Pfad; vor Release erforderlich)
  - Wenn das unmittelbar vorherige npm-Release bekanntermaßen defekt ist, setzen Sie `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` oder `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` für den Preinstall-Schritt.
- [ ] (Optional) Vollständiger Installer-Smoke-Test (fügt Non-Root- + CLI-Abdeckung hinzu): `pnpm test:install:smoke`
- [ ] (Optional) Installer-E2E (Docker, führt `curl -fsSL https://openclaw.ai/install.sh | bash` aus, Onboarding, dann reale Tool-Aufrufe):
  - `pnpm test:install:e2e:openai` (erfordert `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (erfordert `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (erfordert beide Schlüssel; führt beide Anbieter aus)
- [ ] (Optional) Stichprobenartige Prüfung des Web-Gateways, wenn Ihre Änderungen Sende-/Empfangspfade betreffen.

5. **macOS-App (Sparkle)**

- [ ] Erstellen und signieren Sie die macOS-App und zippen Sie sie anschließend für die Distribution.
- [ ] Generieren Sie den Sparkle-Appcast (HTML-Notes via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) und aktualisieren Sie `appcast.xml`.
- [ ] Halten Sie das App-Zip (und optional das dSYM-Zip) bereit, um es an den GitHub-Release anzuhängen.
- [ ] Folgen Sie [macOS release](/platforms/mac/release) für die exakten Befehle und erforderlichen Umgebungsvariablen.
  - `APP_BUILD` muss numerisch + monoton sein (keine `-beta`), damit Sparkle Versionen korrekt vergleicht.
  - Wenn Sie notarisiert haben, verwenden Sie das `openclaw-notary`-Keychain-Profil, das aus App Store Connect API-Umgebungsvariablen erstellt wurde (siehe [macOS release](/platforms/mac/release)).

6. **Veröffentlichen (npm)**

- [ ] Bestätigen Sie, dass der Git-Status sauber ist; committen und pushen Sie bei Bedarf.
- [ ] `npm login` (2FA verifizieren), falls erforderlich.
- [ ] `npm publish --access public` (verwenden Sie `--tag beta` für Pre-Releases).
- [ ] Verifizieren Sie die Registry: `npm view openclaw version`, `npm view openclaw dist-tags` und `npx -y openclaw@X.Y.Z --version` (oder `--help`).

### Fehlerbehebung (Notizen aus dem Release 2.0.0-beta2)

- **npm pack/publish hängt oder erzeugt einen riesigen Tarball**: Das macOS-App-Bundle in `dist/OpenClaw.app` (und Release-Zips) werden in das Paket aufgenommen. Beheben Sie dies durch Whitelisting der Publish-Inhalte via `package.json` `files` (dist-Unterverzeichnisse, Doku, Skills einschließen; App-Bundles ausschließen). Bestätigen Sie mit `npm pack --dry-run`, dass `dist/OpenClaw.app` nicht aufgeführt ist.
- **npm auth Web-Loop für Dist-Tags**: Verwenden Sie Legacy-Auth, um eine OTP-Abfrage zu erhalten:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx`-Verifizierung schlägt mit `ECOMPROMISED: Lock compromised` fehl**: Wiederholen Sie den Vorgang mit einem frischen Cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag muss nach einem späten Fix neu gesetzt werden**: Erzwingen Sie das Update und pushen Sie den Tag, und stellen Sie anschließend sicher, dass die GitHub-Release-Artefakte weiterhin übereinstimmen:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub-Release + Appcast**

- [ ] Taggen und pushen: `git tag vX.Y.Z && git push origin vX.Y.Z` (oder `git push --tags`).
- [ ] Erstellen/Aktualisieren Sie den GitHub-Release für `vX.Y.Z` mit **Titel `openclaw X.Y.Z`** (nicht nur der Tag); der Text muss den **vollständigen** Changelog-Abschnitt für diese Version enthalten (Highlights + Changes + Fixes), inline (keine reinen Links), und **darf den Titel im Text nicht wiederholen**.
- [ ] Artefakte anhängen: `npm pack`-Tarball (optional), `OpenClaw-X.Y.Z.zip` und `OpenClaw-X.Y.Z.dSYM.zip` (falls erzeugt).
- [ ] Committen Sie das aktualisierte `appcast.xml` und pushen Sie es (Sparkle speist aus main).
- [ ] Führen Sie aus einem sauberen temporären Verzeichnis (kein `package.json`) `npx -y openclaw@X.Y.Z send --help` aus, um zu bestätigen, dass Installation/CLI-Entrypoints funktionieren.
- [ ] Release Notes ankündigen/teilen.

## Plugin-Publish-Scope (npm)

Wir veröffentlichen nur **bestehende npm-Plugins** unter dem Scope `@openclaw/*`. Gebündelte
Plugins, die nicht auf npm sind, bleiben **nur im Disk-Tree** (werden weiterhin in
`extensions/**` ausgeliefert).

Vorgehen zur Ermittlung der Liste:

1. `npm search @openclaw --json` ausführen und die Paketnamen erfassen.
2. Mit den `extensions/*/package.json`-Namen vergleichen.
3. Nur die **Schnittmenge** (bereits auf npm) veröffentlichen.

Aktuelle npm-Plugin-Liste (bei Bedarf aktualisieren):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Release Notes müssen außerdem **neue optionale gebündelte Plugins** hervorheben, die **nicht standardmäßig aktiviert** sind (Beispiel: `tlon`).
