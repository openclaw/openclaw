---
summary: "Gabay sa setup para sa mga developer na nagtatrabaho sa OpenClaw macOS app"
read_when:
  - Pagse-set up ng macOS development environment
title: "macOS Dev Setup"
---

# Setup para sa macOS Developer

Sinasaklaw ng gabay na ito ang mga kinakailangang hakbang para i-build at patakbuhin ang OpenClaw macOS application mula sa source.

## Mga paunang kinakailangan

Bago i-build ang app, tiyaking naka-install ang mga sumusunod:

1. **Xcode 26.2+**: Kinakailangan para sa Swift development.
2. **Node.js 22+ & pnpm**: Kinakailangan para sa Gateway, CLI, at mga packaging script.

## 1) I-install ang mga Dependency

I-install ang mga dependency sa buong proyekto:

```bash
pnpm install
```

## 2. I-build at I-package ang App

Para i-build ang macOS app at i-package ito sa `dist/OpenClaw.app`, patakbuhin ang:

```bash
./scripts/package-mac-app.sh
```

Kung wala kang Apple Developer ID certificate, awtomatikong gagamit ang script ng **ad-hoc signing** (`-`).

Para sa mga dev run mode, signing flags, at pag-troubleshoot ng Team ID, tingnan ang macOS app README:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Tandaan**: Ang mga ad-hoc na signed app ay maaaring mag-trigger ng mga security prompt. Kung agad na nagka-crash ang app na may "Abort trap 6", tingnan ang seksyong [Troubleshooting](#troubleshooting).

## 3. I-install ang CLI

Inaasahan ng macOS app ang isang global na `openclaw` na CLI install para pamahalaan ang mga background task.

**Para i-install ito (inirerekomenda):**

1. Buksan ang OpenClaw app.
2. Pumunta sa **General** na settings tab.
3. I-click ang **"Install CLI"**.

Bilang alternatibo, i-install ito nang manu-mano:

```bash
npm install -g openclaw@<version>
```

## Pag-troubleshoot

### Nabibigo ang Build: Hindi tugma ang Toolchain o SDK

Inaasahan ng macOS app build ang pinakabagong macOS SDK at Swift 6.2 toolchain.

**Mga system dependency (kinakailangan):**

- **Pinakabagong bersyon ng macOS na available sa Software Update** (kinakailangan ng Xcode 26.2 SDKs)
- **Xcode 26.2** (Swift 6.2 toolchain)

**Mga pagsusuri:**

```bash
xcodebuild -version
xcrun swift --version
```

Kung hindi tugma ang mga bersyon, i-update ang macOS/Xcode at patakbuhin muli ang build.

### Nagka-crash ang App sa Pagbigay ng Pahintulot

Kung nagka-crash ang app kapag sinusubukan mong payagan ang access sa **Speech Recognition** o **Microphone**, maaaring dahil ito sa sirang TCC cache o hindi tugmang signature.

**Ayusin:**

1. I-reset ang mga pahintulot ng TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Kung hindi gumana, pansamantalang baguhin ang `BUNDLE_ID` sa [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) para pilitin ang isang "clean slate" mula sa macOS.

### Gateway na "Starting..." nang walang katapusan

Kung nananatili sa "Starting..." ang status ng Gateway, tingnan kung may zombie process na humahawak sa port:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Kung may manu-manong run na humahawak sa port, ihinto ang prosesong iyon (Ctrl+C). Bilang huling hakbang, patayin ang PID na nahanap mo sa itaas.
