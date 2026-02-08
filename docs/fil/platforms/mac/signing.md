---
summary: "Mga hakbang sa pag-sign para sa mga macOS debug build na ginagawa ng mga packaging script"
read_when:
  - Pagbuo o pag-sign ng mga mac debug build
title: "Pag-sign sa macOS"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:46Z
---

# pag-sign sa mac (mga debug build)

Ang app na ito ay karaniwang binubuo mula sa [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), na ngayon ay:

- nagse-set ng isang stable na debug bundle identifier: `ai.openclaw.mac.debug`
- sinusulat ang Info.plist gamit ang bundle id na iyon (maaaring i-override sa pamamagitan ng `BUNDLE_ID=...`)
- tinatawag ang [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) para i-sign ang pangunahing binary at app bundle upang ituring ng macOS ang bawat rebuild bilang iisang signed bundle at mapanatili ang mga pahintulot ng TCC (notifications, accessibility, screen recording, mic, speech). Para sa stable na mga pahintulot, gumamit ng totoong signing identity; ang ad-hoc ay opt-in at marupok (tingnan ang [macOS permissions](/platforms/mac/permissions)).
- gumagamit ng `CODESIGN_TIMESTAMP=auto` bilang default; pinapagana nito ang trusted timestamps para sa mga Developer ID signature. Itakda ang `CODESIGN_TIMESTAMP=off` upang laktawan ang timestamping (offline na mga debug build).
- nag-iinject ng build metadata sa Info.plist: `OpenClawBuildTimestamp` (UTC) at `OpenClawGitCommit` (maikling hash) upang maipakita ng About pane ang build, git, at debug/release channel.
- **Nangangailangan ang packaging ng Node 22+**: pinapatakbo ng script ang mga TS build at ang Control UI build.
- binabasa ang `SIGN_IDENTITY` mula sa environment. Idagdag ang `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (o ang iyong Developer ID Application cert) sa iyong shell rc upang palaging mag-sign gamit ang iyong cert. Ang ad-hoc signing ay nangangailangan ng tahasang opt-in sa pamamagitan ng `ALLOW_ADHOC_SIGNING=1` o `SIGN_IDENTITY="-"` (hindi inirerekomenda para sa pagsusuri ng mga pahintulot).
- nagpapatakbo ng Team ID audit pagkatapos mag-sign at bumabagsak kung may anumang Mach-O sa loob ng app bundle na naka-sign ng ibang Team ID. Itakda ang `SKIP_TEAM_ID_CHECK=1` upang i-bypass.

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

Kapag nag-sign gamit ang `SIGN_IDENTITY="-"` (ad-hoc), awtomatikong dini-disable ng script ang **Hardened Runtime** (`--options runtime`). Kailangan ito upang maiwasan ang mga crash kapag sinusubukan ng app na mag-load ng mga embedded framework (tulad ng Sparkle) na hindi pareho ang Team ID. Sinisira rin ng ad-hoc signatures ang pagpapanatili ng mga pahintulot ng TCC; tingnan ang [macOS permissions](/platforms/mac/permissions) para sa mga hakbang sa pagbawi.

## Build metadata para sa About

`package-mac-app.sh` ay nagtatatak sa bundle ng:

- `OpenClawBuildTimestamp`: ISO8601 UTC sa oras ng packaging
- `OpenClawGitCommit`: maikling git hash (o `unknown` kung hindi available)

Binabasa ng About tab ang mga key na ito upang ipakita ang bersyon, petsa ng build, git commit, at kung ito ay isang debug build (sa pamamagitan ng `#if DEBUG`). Patakbuhin muli ang packager upang i-refresh ang mga halagang ito pagkatapos ng mga pagbabago sa code.

## Bakit

Ang mga pahintulot ng TCC ay naka-ugnay sa bundle identifier _at_ sa code signature. Ang mga unsigned na debug build na may pabago-bagong UUID ay nagdudulot na makalimutan ng macOS ang mga grant pagkatapos ng bawat rebuild. Ang pag-sign sa mga binary (ad-hoc bilang default) at pagpapanatili ng isang fixed na bundle id/path (`dist/OpenClaw.app`) ay nagpapanatili ng mga grant sa pagitan ng mga build, na tumutugma sa approach ng VibeTunnel.
