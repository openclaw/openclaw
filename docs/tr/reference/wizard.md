---
summary: "CLI onboarding sihirbazı için tam başvuru: her adım, bayrak ve yapılandırma alanı"
read_when:
  - Belirli bir sihirbaz adımını veya bayrağını ararken
  - Etkileşimsiz modla onboarding’i otomatikleştirirken
  - Sihirbaz davranışında hata ayıklarken
title: "Onboarding Sihirbazı Başvurusu"
sidebarTitle: "reference/wizard.md"
---

# Onboarding Sihirbazı Başvurusu

Bu belge, `openclaw onboard` CLI sihirbazının tam başvurusudur.
Üst düzey bir genel bakış için [Onboarding Sihirbazı](/start/wizard) sayfasına bakın.

## Akış ayrıntıları (yerel mod)

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json` mevcutsa **Koru / Değiştir / Sıfırla** seçeneklerinden biri seçilir.
    - Sihirbazı yeniden çalıştırmak, siz açıkça **Sıfırla**yı seçmedikçe
      (veya `--reset` geçmedikçe) hiçbir şeyi **silmez**.
    - Yapılandırma geçersizse veya eski anahtarlar içeriyorsa, sihirbaz durur ve
      devam etmeden önce `openclaw doctor` çalıştırmanızı ister.
    - Sıfırlama `trash` kullanır (asla `rm` değil) ve kapsam seçenekleri sunar:
      - Yalnızca yapılandırma
      - Yapılandırma + kimlik bilgileri + oturumlar
      - Tam sıfırlama (çalışma alanını da kaldırır)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API anahtarı (önerilir)**: mevcutsa `ANTHROPIC_API_KEY` kullanır veya bir anahtar ister, ardından daemon kullanımı için kaydeder.
    - **Anthropic OAuth (Claude Code CLI)**: macOS’ta sihirbaz “Claude Code-credentials” Keychain öğesini kontrol eder (“Always Allow” seçin ki launchd başlatmaları engellenmesin); Linux/Windows’ta mevcutsa `~/.claude/.credentials.json` yeniden kullanılır.
    - **Anthropic token’ı (setup-token yapıştır)**: herhangi bir makinede `claude setup-token` çalıştırın, ardından token’ı yapıştırın (ad verebilirsiniz; boş = varsayılan).
    - **OpenAI Code (Codex) aboneliği (Codex CLI)**: `~/.codex/auth.json` mevcutsa sihirbaz yeniden kullanabilir.
    - **OpenAI Code (Codex) aboneliği (OAuth)**: tarayıcı akışı; `code#state`’u yapıştırın.
      - Model ayarlı değilse veya `openai/*` ise `agents.defaults.model`’ı `openai-codex/gpt-5.2` olarak ayarlar.
    - **OpenAI API anahtarı**: mevcutsa `OPENAI_API_KEY` kullanır veya anahtar ister, ardından launchd okuyabilsin diye `~/.openclaw/.env`’e kaydeder.
    - **xAI (Grok) API anahtarı**: `XAI_API_KEY` ister ve xAI’yi bir model sağlayıcısı olarak yapılandırır.
    - **OpenCode Zen (çoklu model proxy)**: `OPENCODE_API_KEY` (veya `OPENCODE_ZEN_API_KEY`, https://opencode.ai/auth adresinden alın) ister.
    - **API anahtarı**: anahtarı sizin için saklar.
    - **Vercel AI Gateway (çoklu model proxy)**: `AI_GATEWAY_API_KEY` ister.
    - Daha fazla ayrıntı: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: Hesap Kimliği, Gateway Kimliği ve `CLOUDFLARE_AI_GATEWAY_API_KEY` ister.
    - Daha fazla ayrıntı: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: yapılandırma otomatik olarak yazılır.
    - Daha fazla ayrıntı: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic uyumlu)**: `SYNTHETIC_API_KEY` ister.
    - Daha fazla ayrıntı: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: yapılandırma otomatik olarak yazılır.
    - **Kimi Coding**: yapılandırma otomatik olarak yazılır.
    - Daha fazla ayrıntı: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Atla**: henüz kimlik doğrulama yapılandırılmaz.
    - Algılanan seçeneklerden varsayılan bir model seçin (veya sağlayıcı/modeli manuel girin).
    - Sihirbaz bir model denetimi çalıştırır ve yapılandırılan model bilinmiyorsa veya kimlik doğrulama eksikse uyarır.
    - OAuth kimlik bilgileri `~/.openclaw/credentials/oauth.json` altında; kimlik doğrulama profilleri `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` altında bulunur (API anahtarları + OAuth).
    - Daha fazla ayrıntı: [/concepts/oauth](/concepts/oauth)    
<Note>
    Başsız/sunucu ipucu: OAuth’u tarayıcılı bir makinede tamamlayın, ardından
    `~/.openclaw/credentials/oauth.json` (veya `$OPENCLAW_STATE_DIR/credentials/oauth.json`) dosyasını
    gateway ana makinesine kopyalayın.
    </Note>
  </Step>
  <Step title="Workspace">
    - Varsayılan `~/.openclaw/workspace` (yapılandırılabilir).
    - Ajan bootstrap ritüeli için gereken çalışma alanı dosyalarını oluşturur.
    - Tam çalışma alanı düzeni + yedekleme kılavuzu: [Ajan çalışma alanı](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, bağlama, kimlik doğrulama modu, Tailscale yayını.
    - Kimlik doğrulama önerisi: local loopback için bile **Token**’ı koruyun; böylece yerel WS istemcileri kimlik doğrulamak zorunda kalır.
    - Kimlik doğrulamayı yalnızca tüm yerel süreçlere tamamen güveniyorsanız devre dışı bırakın.
    - Loopback olmayan bağlamalar yine de kimlik doğrulama gerektirir.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): isteğe bağlı QR ile giriş.
    - [Telegram](/channels/telegram): bot belirteci.
    - [Discord](/channels/discord): bot belirteci.
    - [Google Chat](/channels/googlechat): hizmet hesabı JSON’u + webhook hedef kitlesi.
    - [Mattermost](/channels/mattermost) (eklenti): bot belirteci + temel URL.
    - [Signal](/channels/signal): isteğe bağlı `signal-cli` kurulumu + hesap yapılandırması.
    - [BlueBubbles](/channels/bluebubbles): **iMessage için önerilir**; sunucu URL’si + parola + webhook.
    - [iMessage](/channels/imessage): eski `imsg` CLI yolu + veritabanı erişimi.
    - DM güvenliği: varsayılan eşleştirmedir. İlk DM bir kod gönderir; `openclaw pairing approve <channel><code>` üzerinden onaylayın veya izin listeleri kullanın.
  </Step><code>` üzerinden onaylayın veya izin listeleri kullanın.
  </Step>
  <Step title="Daemon kurulumu">
    - macOS: LaunchAgent
      - Oturum açmış bir kullanıcı oturumu gerektirir; başsız kullanım için özel bir LaunchDaemon kullanın (pakete dahil değildir).
    - Linux (ve WSL2 üzerinden Windows): systemd kullanıcı birimi
      - Sihirbaz, çıkıştan sonra Gateway’in ayakta kalması için `loginctl enable-linger <user>` ile lingering’i etkinleştirmeye çalışır.
      - sudo isteyebilir (`/var/lib/systemd/linger` yazar); önce sudo olmadan dener.
    - **Çalışma zamanı seçimi:** Node (önerilir; WhatsApp/Telegram için gereklidir). Bun **önerilmez**.
  </Step>
  <Step title="Sağlık denetimi">
    - Gerekirse Gateway’i başlatır ve `openclaw health` çalıştırır.
    - İpucu: `openclaw status --deep`, durum çıktısına gateway sağlık yoklamaları ekler (erişilebilir bir gateway gerektirir).
  </Step>
  <Step title="Skills (önerilir)">
    - Mevcut Skills’leri okur ve gereksinimleri denetler.
    - Bir node yöneticisi seçmenizi sağlar: **npm / pnpm** (bun önerilmez).
    - İsteğe bağlı bağımlılıkları kurar (bazıları macOS’ta Homebrew kullanır).
  </Step>
  <Step title="Bitir">
    - Ek özellikler için iOS/Android/macOS uygulamaları dahil özet + sonraki adımlar.
  </Step>
</Steps>

<Note>
GUI algılanmazsa, sihirbaz tarayıcı açmak yerine Control UI için SSH port yönlendirme talimatlarını yazdırır.
Control UI varlıkları eksikse, sihirbaz bunları oluşturmaya çalışır; geri dönüş seçeneği `pnpm ui:build`’tür (UI bağımlılıklarını otomatik kurar).
</Note>

## Etkileşimsiz mod

Onboarding’i otomatikleştirmek veya betiklemek için `--non-interactive` kullanın:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Makine tarafından okunabilir bir özet için `--json` ekleyin.

<Note>
`--json`, **etkileşimsiz mod** anlamına gelmez. Betikler için `--non-interactive` (ve `--workspace`) kullanın.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Ajan ekle (etkileşimsiz)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway sihirbazı RPC

Gateway, sihirbaz akışını RPC üzerinden sunar (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
İstemciler (macOS uygulaması, Control UI) onboarding mantığını yeniden uygulamadan adımları render edebilir.

## Signal kurulumu (signal-cli)

Sihirbaz, GitHub sürümlerinden `signal-cli` kurabilir:

- Uygun sürüm varlığını indirir.
- `~/.openclaw/tools/signal-cli/<version>/` altına kaydeder.
- Yapılandırmanıza `channels.signal.cliPath` yazar.

Notlar:

- JVM derlemeleri **Java 21** gerektirir.
- Mevcut olduğunda yerel derlemeler kullanılır.
- Windows WSL2 kullanır; signal-cli kurulumu WSL içindeki Linux akışını izler.

## Sihirbazın yazdıkları

`~/.openclaw/openclaw.json` içindeki tipik alanlar:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (MiniMax seçildiyse)
- `gateway.*` (mod, bağlama, kimlik doğrulama, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- İstemler sırasında tercih ettiğinizde kanal izin listeleri (Slack/Discord/Matrix/Microsoft Teams) (adlar mümkün olduğunda kimliklere çözülür).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`, `agents.list[]` ve isteğe bağlı `bindings` yazar.

WhatsApp kimlik bilgileri `~/.openclaw/credentials/whatsapp/<accountId>/` altında bulunur.
Oturumlar `~/.openclaw/agents/<agentId>/sessions/` altında saklanır.

Bazı kanallar eklenti olarak sunulur. Onboarding sırasında birini seçtiğinizde, sihirbaz
yapılandırılabilmesi için önce onu kurmayı (npm veya yerel bir yol) ister.

## İlgili belgeler

- Sihirbaz genel bakışı: [Onboarding Sihirbazı](/start/wizard)
- macOS uygulaması onboarding: [Onboarding](/start/onboarding)
- Yapılandırma başvurusu: [Gateway yapılandırması](/gateway/configuration)
- Sağlayıcılar: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (eski)
- Skills: [Skills](/tools/skills), [Skills yapılandırması](/tools/skills-config)
