---
summary: "I-install ang OpenClaw nang deklaratibo gamit ang Nix"
read_when:
  - Gusto mo ng reproducible at may rollback na mga install
  - Gumagamit ka na ng Nix/NixOS/Home Manager
  - Gusto mo na naka-pin at pinamamahalaan nang deklaratibo ang lahat
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:34Z
---

# Pag-install ng Nix

Ang inirerekomendang paraan para patakbuhin ang OpenClaw gamit ang Nix ay sa pamamagitan ng **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — isang Home Manager module na kumpleto na ang lahat (batteries-included).

## Mabilis na pagsisimula

I-paste ito sa iyong AI agent (Claude, Cursor, atbp.):

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 Buong gabay: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> Ang nix-openclaw repo ang source of truth para sa pag-install ng Nix. Ang page na ito ay isang mabilis na pangkalahatang-ideya lamang.

## Ano ang makukuha mo

- Gateway + macOS app + mga tool (whisper, spotify, cameras) — lahat ay naka-pin
- Launchd service na tumatagal kahit mag-reboot
- Plugin system na may deklaratibong config
- Instant rollback: `home-manager switch --rollback`

---

## Runtime Behavior ng Nix Mode

Kapag naka-set ang `OPENCLAW_NIX_MODE=1` (awtomatiko gamit ang nix-openclaw):

Sinusuportahan ng OpenClaw ang **Nix mode** na ginagawang deterministic ang configuration at dini-disable ang mga auto-install flow.
I-enable ito sa pamamagitan ng pag-export ng:

```bash
OPENCLAW_NIX_MODE=1
```

Sa macOS, hindi awtomatikong minamana ng GUI app ang shell env vars. Maaari mo ring
i-enable ang Nix mode sa pamamagitan ng defaults:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Mga path ng config + state

Binabasa ng OpenClaw ang JSON5 config mula sa `OPENCLAW_CONFIG_PATH` at iniimbak ang mutable na data sa `OPENCLAW_STATE_DIR`.

- `OPENCLAW_STATE_DIR` (default: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (default: `$OPENCLAW_STATE_DIR/openclaw.json`)

Kapag tumatakbo sa ilalim ng Nix, itakda ang mga ito nang tahasan sa mga lokasyong pinamamahalaan ng Nix upang ang runtime state at config
ay manatili sa labas ng immutable store.

### Runtime behavior sa Nix mode

- Ang mga auto-install at self-mutation flow ay dini-disable
- Ang mga nawawalang dependency ay nagpapakita ng mga Nix-specific na remediation message
- Ang UI ay nagpapakita ng read-only na Nix mode banner kapag naroroon

## Tala sa packaging (macOS)

Inaasahan ng macOS packaging flow ang isang stable na Info.plist template sa:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

Kinokopya ng [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) ang template na ito papunta sa app bundle at ina-update ang mga dynamic field
(bundle ID, version/build, Git SHA, Sparkle keys). Pinananatili nitong deterministic ang plist para sa SwiftPM
packaging at mga Nix build (na hindi umaasa sa isang buong Xcode toolchain).

## Kaugnay

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — buong gabay sa setup
- [Wizard](/start/wizard) — non-Nix CLI setup
- [Docker](/install/docker) — containerized setup
