---
summary: "OpenClaw’ı Nix ile bildirime dayalı olarak kurun"
read_when:
  - Tekrarlanabilir, geri alınabilir kurulumlar istiyorsanız
  - Halihazırda Nix/NixOS/Home Manager kullanıyorsanız
  - Her şeyin sabitlenmiş ve bildirime dayalı olarak yönetilmesini istiyorsanız
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:26Z
---

# Nix Kurulumu

OpenClaw’ı Nix ile çalıştırmanın önerilen yolu, piller dâhil bir Home Manager modülü olan **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** üzerinden kurulmasıdır.

## Hızlı Başlangıç

Bunu AI ajanınıza (Claude, Cursor, vb.) yapıştırın:

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

> **📦 Tam kılavuz: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw deposu, Nix kurulumu için asıl başvuru kaynağıdır. Bu sayfa yalnızca hızlı bir genel bakıştır.

## Neler elde edersiniz

- Gateway + macOS uygulaması + araçlar (whisper, spotify, kameralar) — tamamı sabitlenmiş
- Yeniden başlatmalardan sonra da çalışan Launchd servisi
- Bildirime dayalı yapılandırmaya sahip eklenti sistemi
- Anında geri alma: `home-manager switch --rollback`

---

## Nix Modu Çalışma Zamanı Davranışı

`OPENCLAW_NIX_MODE=1` ayarlandığında (nix-openclaw ile otomatik):

OpenClaw, yapılandırmayı deterministik hâle getiren ve otomatik kurulum akışlarını devre dışı bırakan bir **Nix modu** destekler.
Aşağıdakini dışa aktararak etkinleştirin:

```bash
OPENCLAW_NIX_MODE=1
```

macOS’te GUI uygulaması kabuk ortam değişkenlerini otomatik olarak devralmaz. Nix modunu
defaults üzerinden de etkinleştirebilirsiniz:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Yapılandırma + durum yolları

OpenClaw, JSON5 yapılandırmasını `OPENCLAW_CONFIG_PATH` konumundan okur ve değiştirilebilir verileri `OPENCLAW_STATE_DIR` konumunda saklar.

- `OPENCLAW_STATE_DIR` (varsayılan: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (varsayılan: `$OPENCLAW_STATE_DIR/openclaw.json`)

Nix altında çalışırken, çalışma zamanı durumu ve yapılandırmanın değişmez store dışında kalması için
bunları Nix tarafından yönetilen konumlara açıkça ayarlayın.

### Nix modunda çalışma zamanı davranışı

- Otomatik kurulum ve kendini değiştirme akışları devre dışıdır
- Eksik bağımlılıklar, Nix’e özgü çözüm mesajlarıyla görünür
- UI, mevcut olduğunda salt okunur bir Nix modu bandı gösterir

## Paketleme notu (macOS)

macOS paketleme akışı, aşağıdaki konumda kararlı bir Info.plist şablonu bekler:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) bu şablonu uygulama paketine kopyalar ve dinamik alanları
(paket kimliği, sürüm/yapı, Git SHA, Sparkle anahtarları) yamalar. Bu yaklaşım, SwiftPM
paketleme ve Nix derlemeleri için (tam bir Xcode araç zincirine dayanmadıkları için) plist’in deterministik kalmasını sağlar.

## İlgili

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — tam kurulum kılavuzu
- [Wizard](/start/wizard) — Nix olmayan CLI kurulumu
- [Docker](/install/docker) — konteyner tabanlı kurulum
