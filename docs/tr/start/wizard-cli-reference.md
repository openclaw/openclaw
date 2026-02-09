---
summary: "CLI onboarding akışı, kimlik doğrulama/model kurulumu, çıktılar ve iç yapılar için tam referans"
read_when:
  - OpenClaw onboard işleminin ayrıntılı davranışına ihtiyaç duyduğunuzda
  - Onboarding sonuçlarını hata ayıklarken veya onboarding istemcilerini entegre ederken
title: "CLI Onboarding Referansı"
sidebarTitle: "CLI referansı"
---

# CLI Onboarding Referansı

Bu sayfa `openclaw onboard` için tam referanstır.
Kısa kılavuz için bkz. [Onboarding Wizard (CLI)](/start/wizard).

## Wizard ne yapar

Yerel mod (varsayılan) sizi şu adımlardan geçirir:

- Model ve kimlik doğrulama kurulumu (OpenAI Code aboneliği OAuth, Anthropic API anahtarı veya setup-token; ayrıca MiniMax, GLM, Moonshot ve AI Gateway seçenekleri)
- Çalışma alanı konumu ve bootstrap dosyaları
- Gateway ayarları (port, bind, auth, tailscale)
- Kanallar ve sağlayıcılar (Telegram, WhatsApp, Discord, Google Chat, Mattermost eklentisi, Signal)
- Daemon kurulumu (LaunchAgent veya systemd kullanıcı birimi)
- Sağlık kontrolü
- Skills kurulumu

Uzak mod, bu makineyi başka bir yerdeki bir gateway’e bağlanacak şekilde yapılandırır.
Uzak ana makinede hiçbir şey kurmaz veya değiştirmez.

## Yerel akış ayrıntıları

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json` varsa, Koru, Değiştir veya Sıfırla seçeneklerinden birini seçin.
    - Wizard’ı yeniden çalıştırmak, açıkça Sıfırla’yı seçmedikçe (veya `--reset` geçmedikçe) hiçbir şeyi silmez.
    - Yapılandırma geçersizse veya eski anahtarlar içeriyorsa, wizard durur ve devam etmeden önce `openclaw doctor` çalıştırmanızı ister.
    - Sıfırlama `trash` kullanır ve kapsamlar sunar:
      - Yalnızca yapılandırma
      - Yapılandırma + kimlik bilgileri + oturumlar
      - Tam sıfırlama (çalışma alanını da kaldırır)  
</Step>
  <Step title="Model and auth">
    - Tüm seçenek matrisi [Kimlik doğrulama ve model seçenekleri](#auth-and-model-options) bölümündedir.
  </Step>
  <Step title="Workspace">
    - Varsayılan `~/.openclaw/workspace` (yapılandırılabilir).
    - İlk çalıştırma bootstrap ritüeli için gereken çalışma alanı dosyalarını oluşturur.
    - Çalışma alanı düzeni: [Ajan çalışma alanı](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Port, bind, auth modu ve tailscale açılımı için sorular sorar.
    - Önerilen: local loopback için bile belirteç tabanlı kimlik doğrulamayı açık tutun; böylece yerel WS istemcileri kimlik doğrulamak zorunda kalır.
    - Yalnızca tüm yerel süreçlere tamamen güveniyorsanız kimlik doğrulamayı devre dışı bırakın.
    - Loopback olmayan bind’ler yine kimlik doğrulama gerektirir.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): isteğe bağlı QR girişi
    - [Telegram](/channels/telegram): bot belirteci
    - [Discord](/channels/discord): bot belirteci
    - [Google Chat](/channels/googlechat): servis hesabı JSON + webhook audience
    - [Mattermost](/channels/mattermost) eklentisi: bot belirteci + temel URL
    - [Signal](/channels/signal): isteğe bağlı `signal-cli` kurulumu + hesap yapılandırması
    - [BlueBubbles](/channels/bluebubbles): iMessage için önerilir; sunucu URL’si + parola + webhook
    - [iMessage](/channels/imessage): eski `imsg` CLI yolu + DB erişimi
    - DM güvenliği: varsayılan eşleştirmedir. İlk DM bir kod gönderir; şu yollarla onaylayın:
      `openclaw pairing approve <channel><code>` veya izin listelerini kullanın.
  </Step><code>` veya izin listelerini kullanın.
  </Step>
  <Step title="Daemon kurulumu">
    - macOS: LaunchAgent
      - Oturum açmış kullanıcı oturumu gerektirir; headless için özel bir LaunchDaemon kullanın (paketle gelmez).
    - Linux ve Windows (WSL2 üzerinden): systemd kullanıcı birimi
      - Wizard, çıkıştan sonra gateway’in çalışmaya devam etmesi için `loginctl enable-linger <user>` denemesi yapar.
      - Sudo isteyebilir (`/var/lib/systemd/linger` yazar); önce sudo olmadan dener.
    - Çalışma zamanı seçimi: Node (önerilir; WhatsApp ve Telegram için gereklidir). Bun önerilmez.
  </Step>
  <Step title="Sağlık kontrolü">
    - Gerekirse gateway’i başlatır ve `openclaw health` çalıştırır.
    - `openclaw status --deep`, durum çıktısına gateway sağlık problarını ekler.
  </Step>
  <Step title="Skills">
    - Mevcut Skills’i okur ve gereksinimleri kontrol eder.
    - Node yöneticisini seçmenizi sağlar: npm veya pnpm (bun önerilmez).
    - İsteğe bağlı bağımlılıkları kurar (bazıları macOS’ta Homebrew kullanır).
  </Step>
  <Step title="Bitiş">
    - iOS, Android ve macOS uygulama seçenekleri dahil olmak üzere özet ve sonraki adımlar.
  </Step>
</Steps>

<Note>
GUI algılanmazsa, wizard tarayıcı açmak yerine Control UI için SSH port yönlendirme talimatlarını yazdırır.
Control UI varlıkları eksikse, wizard bunları derlemeyi dener; geri dönüş `pnpm ui:build`’tür (UI bağımlılıklarını otomatik kurar).
</Note>

## Uzak mod ayrıntıları

Uzak mod, bu makineyi başka bir yerdeki bir gateway’e bağlanacak şekilde yapılandırır.

<Info>
Uzak mod, uzak ana makinede hiçbir şey kurmaz veya değiştirmez.
</Info>

7. Ayarladıklarınız:

- Uzak gateway URL’si (`ws://...`)
- Uzak gateway kimlik doğrulaması gerekiyorsa belirteç (önerilir)

<Note>
- Gateway yalnızca loopback ise, SSH tüneli veya bir tailnet kullanın.
- Keşif ipuçları:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Kimlik doğrulama ve model seçenekleri

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Mevcutsa `ANTHROPIC_API_KEY` kullanır veya bir anahtar ister; ardından daemon kullanımı için kaydeder.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: Keychain öğesi "Claude Code-credentials" kontrol edilir
    - Linux ve Windows: mevcutsa `~/.claude/.credentials.json` yeniden kullanılır

    ```
    macOS’ta, launchd başlatmalarının engellenmemesi için "Always Allow" seçin.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Herhangi bir makinede `claude setup-token` çalıştırın, ardından belirteci yapıştırın.
    İsim verebilirsiniz; boş bırakılırsa varsayılan kullanılır.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    `~/.codex/auth.json` varsa, wizard bunu yeniden kullanabilir.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Tarayıcı akışı; `code#state` yapıştırın.

    ```
    Model ayarlanmamışsa veya `openai/*` ise `agents.defaults.model`’yi `openai-codex/gpt-5.3-codex` olarak ayarlar.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Mevcutsa `OPENAI_API_KEY` kullanır veya bir anahtar ister; ardından launchd’ın okuyabilmesi için
    `~/.openclaw/.env` içine kaydeder.

    ```
    Model ayarlanmamışsa, `openai/*` veya `openai-codex/*` ise `agents.defaults.model`’yi `openai/gpt-5.1-codex` olarak ayarlar.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY` ister ve xAI’yi bir model sağlayıcı olarak yapılandırır.
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY` (veya `OPENCODE_ZEN_API_KEY`) ister.
    Kurulum URL’si: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Anahtarı sizin için saklar.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` ister.
    Daha fazla ayrıntı: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Hesap kimliği, gateway kimliği ve `CLOUDFLARE_AI_GATEWAY_API_KEY` ister.
    Daha fazla ayrıntı: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Yapılandırma otomatik olarak yazılır.
    Daha fazla ayrıntı: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY` ister.
    Daha fazla ayrıntı: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) ve Kimi Coding yapılandırmaları otomatik yazılır.
    Daha fazla ayrıntı: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Kimlik doğrulamayı yapılandırmadan bırakır.
  </Accordion>
</AccordionGroup>

Model davranışı:

- Algılanan seçeneklerden varsayılan modeli seçin veya sağlayıcı ve modeli manuel girin.
- Wizard bir model kontrolü çalıştırır ve yapılandırılan model bilinmiyorsa veya kimlik doğrulaması eksikse uyarır.

Kimlik bilgisi ve profil yolları:

- OAuth kimlik bilgileri: `~/.openclaw/credentials/oauth.json`
- Kimlik doğrulama profilleri (API anahtarları + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Headless ve sunucu ipucu: OAuth’u tarayıcı olan bir makinede tamamlayın, ardından
`~/.openclaw/credentials/oauth.json` (veya `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
dosyasını gateway ana makinesine kopyalayın.
</Note>

## Çıktılar ve iç yapılar

`~/.openclaw/openclaw.json` içindeki tipik alanlar:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (MiniMax seçildiyse)
- `gateway.*` (mod, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- İstemde seçtiğinizde kanal izin listeleri (Slack, Discord, Matrix, Microsoft Teams) (mümkün olduğunda adlar kimliklere çözülür)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`, `agents.list[]` ve isteğe bağlı `bindings` yazar.

WhatsApp kimlik bilgileri `~/.openclaw/credentials/whatsapp/<accountId>/` altında tutulur.
Oturumlar `~/.openclaw/agents/<agentId>/sessions/` altında saklanır.

<Note>
Bazı kanallar eklenti olarak sunulur. Onboarding sırasında seçildiğinde, wizard
kanal yapılandırmasından önce eklentiyi (npm veya yerel yol) kurmayı ister.
</Note>

Gateway wizard RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

İstemciler (macOS uygulaması ve Control UI), onboarding mantığını yeniden uygulamadan adımları render edebilir.

Signal kurulum davranışı:

- Uygun sürüm varlığını indirir
- `~/.openclaw/tools/signal-cli/<version>/` altına kaydeder
- Yapılandırmaya `channels.signal.cliPath` yazar
- JVM derlemeleri Java 21 gerektirir
- 8. Mevcut olduğunda yerel derlemeler kullanılır
- Windows, WSL2 kullanır ve WSL içinde Linux signal-cli akışını izler

## İlgili belgeler

- Onboarding merkezi: [Onboarding Wizard (CLI)](/start/wizard)
- Otomasyon ve betikler: [CLI Automation](/start/wizard-cli-automation)
- Komut referansı: [`openclaw onboard`](/cli/onboard)
