---
summary: "Mga hakbang sa pag-sign para sa mga macOS debug build na ginagawa ng mga packaging script"
read_when:
  - Pagbuo o pag-sign ng mga mac debug build
title: "Pag-sign sa macOS"
---

# pag-sign sa mac (mga debug build)

Ang app na ito ay karaniwang binubuo mula sa [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), na ngayon ay:

- nagse-set ng isang stable na debug bundle identifier: `ai.openclaw.mac.debug`
- sinusulat ang Info.plist gamit ang bundle id na iyon (maaaring i-override sa pamamagitan ng `BUNDLE_ID=...`)
- calls [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) to sign the main binary and app bundle so macOS treats each rebuild as the same signed bundle and keeps TCC permissions (notifications, accessibility, screen recording, mic, speech). For stable permissions, use a real signing identity; ad-hoc is opt-in and fragile (see [macOS permissions](/platforms/mac/permissions)).
- 10. gumagamit ng `CODESIGN_TIMESTAMP=auto` bilang default; pinapagana nito ang trusted timestamps para sa Developer ID signatures. Itakda ang `CODESIGN_TIMESTAMP=off` upang laktawan ang timestamping (offline debug builds).
- nag-iinject ng build metadata sa Info.plist: `OpenClawBuildTimestamp` (UTC) at `OpenClawGitCommit` (maikling hash) upang maipakita ng About pane ang build, git, at debug/release channel.
- **Nangangailangan ang packaging ng Node 22+**: pinapatakbo ng script ang mga TS build at ang Control UI build.
- reads `SIGN_IDENTITY` from the environment. Idagdag ang `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (o ang iyong Developer ID Application cert) sa iyong shell rc upang palaging pumirma gamit ang iyong cert. 13. Ang ad-hoc signing ay nangangailangan ng tahasang opt-in sa pamamagitan ng `ALLOW_ADHOC_SIGNING=1` o `SIGN_IDENTITY="-"` (hindi inirerekomenda para sa permission testing).
- 14. nagpapatakbo ng Team ID audit pagkatapos ng signing at babagsak kung may anumang Mach-O sa loob ng app bundle na nilagdaan ng ibang Team ID. Itakda ang `SKIP_TEAM_ID_CHECK=1` upang lampasan.

## Paggamit

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Tala sa Ad-hoc Signing

16. Kapag pumipirma gamit ang `SIGN_IDENTITY="-"` (ad-hoc), awtomatikong dini-disable ng script ang **Hardened Runtime** (`--options runtime`). Kailangan ito para maiwasan ang mga crash kapag sinusubukan ng app na mag-load ng mga naka-embed na framework (tulad ng Sparkle) na hindi kapareho ang Team ID. 17. Sinisira rin ng ad-hoc signatures ang persistence ng TCC permission; tingnan ang [macOS permissions](/platforms/mac/permissions) para sa mga hakbang sa pag-recover.

## Build metadata para sa About

`package-mac-app.sh` ay nagtatatak sa bundle ng:

- `OpenClawBuildTimestamp`: ISO8601 UTC sa oras ng packaging
- `OpenClawGitCommit`: maikling git hash (o `unknown` kung hindi available)

Binabasa ng About tab ang mga key na ito upang ipakita ang bersyon, petsa ng build, git commit, at kung ito ay isang debug build (sa pamamagitan ng `#if DEBUG`). Patakbuhin ang packager upang i-refresh ang mga halagang ito matapos ang mga pagbabago sa code.

## Bakit

TCC permissions are tied to the bundle identifier _and_ code signature. 21. Ang mga unsigned debug build na may nagbabagong UUID ay nagiging sanhi upang makalimutan ng macOS ang mga grant pagkatapos ng bawat rebuild. Ang pag-sign sa mga binary (ad‑hoc bilang default) at pagpapanatili ng nakapirming bundle id/path (`dist/OpenClaw.app`) ay nagpapanatili ng mga grant sa pagitan ng mga build, na tumutugma sa approach ng VibeTunnel.
