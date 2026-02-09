---
summary: "CLI katılım sihirbazı: gateway, çalışma alanı, kanallar ve skills için yönlendirmeli kurulum"
read_when:
  - Katılım sihirbazını çalıştırırken veya yapılandırırken
  - Yeni bir makine kurarken
title: "Katılım Sihirbazı (CLI)"
sidebarTitle: "Katılım: CLI"
---

# Katılım Sihirbazı (CLI)

Katılım sihirbazı, OpenClaw’ı macOS,
Linux veya Windows’ta (WSL2 üzerinden; güçlü şekilde önerilir) kurmanın **önerilen** yoludur.
Yerel bir Gateway veya uzak bir Gateway bağlantısını; ayrıca kanalları, skills’leri
ve çalışma alanı varsayılanlarını tek bir yönlendirmeli akışta yapılandırır.

```bash
openclaw onboard
```

<Info>
En hızlı ilk sohbet: Kontrol UI’sini açın (kanal kurulumu gerekmez). Çalıştırın
`openclaw dashboard` ve tarayıcıda sohbet edin. Belgeler: [Dashboard](/web/dashboard).
</Info>

Daha sonra yeniden yapılandırmak için:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` etkileşimsiz modu ima etmez. Betikler için `--non-interactive` kullanın.
</Note>

<Tip>
Önerilir: ajanın `web_search` kullanabilmesi için bir Brave Search API anahtarı ayarlayın
(`web_fetch` anahtar olmadan çalışır). En kolay yol: `openclaw configure --section web`,
bu da `tools.web.search.apiKey` saklar. Belgeler: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

Sihirbaz **QuickStart** (varsayılanlar) ile **Advanced** (tam kontrol) seçenekleriyle başlar.

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Yerel gateway (loopback)
    - Çalışma alanı varsayılanı (veya mevcut çalışma alanı)
    - Gateway portu **18789**
    - Gateway kimlik doğrulaması **Token** (loopback’te bile otomatik üretilir)
    - Tailscale erişimi **Kapalı**
    - Telegram + WhatsApp DM’leri varsayılan olarak **izin listesi** (telefon numaranız sorulacaktır)
  </Tab>
  <Tab title="Advanced (full control)">
    - Tüm adımları açar (mod, çalışma alanı, gateway, kanallar, daemon, skills).
  </Tab>
</Tabs>

## Sihirbazın yapılandırdıkları

**Yerel mod (varsayılan)** sizi şu adımlardan geçirir:

1. **Model/Auth** — Anthropic API anahtarı (önerilir), OAuth, OpenAI veya diğer sağlayıcılar. Varsayılan bir model seçin.
2. **Workspace** — Ajan dosyaları için konum (varsayılan `~/.openclaw/workspace`). Başlangıç dosyalarını tohumlar.
3. **Gateway** — Port, bağlanma adresi, kimlik doğrulama modu, Tailscale erişimi.
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles veya iMessage.
5. **Daemon** — Bir LaunchAgent (macOS) veya systemd kullanıcı birimi (Linux/WSL2) kurar.
6. **Health check** — Gateway’i başlatır ve çalıştığını doğrular.
7. **Skills** — Önerilen skills’leri ve isteğe bağlı bağımlılıkları kurar.

<Note>
Sihirbazı yeniden çalıştırmak, açıkça **Reset**’i seçmediğiniz (veya `--reset` geçmediğiniz) sürece hiçbir şeyi **silmez**.
Yapılandırma geçersizse veya eski anahtarlar içeriyorsa, sihirbaz önce `openclaw doctor` çalıştırmanızı ister.
</Note>

**Uzak mod** yalnızca yerel istemciyi başka bir yerdeki bir Gateway’e bağlanacak şekilde yapılandırır.
Uzak ana makinede hiçbir şeyi **kurmaz** veya **değiştirmez**.

## 9. Başka bir ajan ekle

Kendi çalışma alanı, oturumları ve kimlik doğrulama profilleri olan ayrı bir ajan oluşturmak için
`openclaw agents add <name>` kullanın. `--workspace` olmadan çalıştırmak sihirbazı başlatır.

10. Ayarladıkları:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notlar:

- Varsayılan çalışma alanları `~/.openclaw/workspace-<agentId>` izler.
- Gelen mesajları yönlendirmek için `bindings` ekleyin (sihirbaz bunu yapabilir).
- Etkileşimsiz bayraklar: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 11. Tam referans

Ayrıntılı adım adım dökümler, etkileşimsiz betikleme, Signal kurulumu,
RPC API ve sihirbazın yazdığı yapılandırma alanlarının tam listesi için
[Wizard Reference](/reference/wizard) bölümüne bakın.

## İlgili belgeler

- CLI komut başvurusu: [`openclaw onboard`](/cli/onboard)
- macOS uygulaması katılımı: [Onboarding](/start/onboarding)
- Ajan ilk çalıştırma ritüeli: [Agent Bootstrapping](/start/bootstrapping)
