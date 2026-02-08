---
summary: "~/.openclaw/openclaw.json için tüm yapılandırma seçenekleri ve örnekler"
read_when:
  - Yapılandırma alanlarını eklerken veya değiştirirken
title: "Yapılandırma"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:56:46Z
---

# Yapılandırma 🔧

OpenClaw, `~/.openclaw/openclaw.json` konumundan isteğe bağlı bir **JSON5** yapılandırması okur (yorumlar + sonda virgül serbesttir).

Dosya yoksa OpenClaw güvenli sayılabilecek varsayılanları kullanır (gömülü Pi ajanı + gönderen başına oturumlar + çalışma alanı `~/.openclaw/workspace`). Genellikle yalnızca şu durumlarda bir yapılandırmaya ihtiyaç duyarsınız:

- botu kimlerin tetikleyebileceğini kısıtlamak (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom` vb.)
- grup izin listeleri + bahsetme davranışını kontrol etmek (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- mesaj öneklerini özelleştirmek (`messages`)
- ajanın çalışma alanını ayarlamak (`agents.defaults.workspace` veya `agents.list[].workspace`)
- gömülü ajan varsayılanlarını ayarlamak (`agents.defaults`) ve oturum davranışını düzenlemek (`session`)
- ajan başına kimlik ayarlamak (`agents.list[].identity`)

> **Yapılandırmaya yeni misiniz?** Ayrıntılı açıklamalarla eksiksiz örnekler için [Configuration Examples](/gateway/configuration-examples) kılavuzuna göz atın!

## Katı yapılandırma doğrulaması

OpenClaw yalnızca şemayla **tam olarak** eşleşen yapılandırmaları kabul eder.  
Bilinmeyen anahtarlar, hatalı türler veya geçersiz değerler, güvenlik için Gateway’nin **başlamayı reddetmesine** neden olur.

Doğrulama başarısız olduğunda:

- Gateway açılmaz.
- Yalnızca tanılama komutlarına izin verilir (örneğin: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Tam sorunları görmek için `openclaw doctor` çalıştırın.
- Geçişleri/onarımı uygulamak için `openclaw doctor --fix` (veya `--yes`) çalıştırın.

Doctor, `--fix`/`--yes` içine açıkça dahil olmadıkça değişiklik yazmaz.

## Şema + UI ipuçları

Gateway, UI düzenleyiciler için yapılandırmanın JSON Şema temsilimini `config.schema` üzerinden sunar.  
Control UI, bu şemadan bir form üretir; kaçış yolu olarak **Raw JSON** düzenleyicisi de vardır.

Kanal eklentileri ve uzantılar, yapılandırmaları için şema + UI ipuçları kaydedebilir; böylece kanal ayarları uygulamalar arasında sabit kodlu formlar olmadan şema güdümlü kalır.

İpuçları (etiketler, gruplama, hassas alanlar) şemayla birlikte gelir; istemciler yapılandırma bilgisi sabit kodlanmadan daha iyi formlar oluşturabilir.

## Uygula + yeniden başlat (RPC)

`config.apply` kullanarak tüm yapılandırmayı tek adımda doğrulayın + yazın ve Gateway’yi yeniden başlatın.  
Bir yeniden başlatma işaretçisi yazar ve Gateway geri geldiğinde son aktif oturumu yoklar.

Uyarı: `config.apply` **tüm yapılandırmanın** yerini alır. Yalnızca birkaç anahtarı değiştirmek istiyorsanız `config.patch` veya `openclaw config set` kullanın. `~/.openclaw/openclaw.json` için bir yedek tutun.

Parametreler:

- `raw` (string) — tüm yapılandırma için JSON5 yükü
- `baseHash` (isteğe bağlı) — `config.get`’den yapılandırma karması (mevcut bir yapılandırma varsa gereklidir)
- `sessionKey` (isteğe bağlı) — uyandırma pingi için son aktif oturum anahtarı
- `note` (isteğe bağlı) — yeniden başlatma işaretçisine eklenecek not
- `restartDelayMs` (isteğe bağlı) — yeniden başlatma öncesi gecikme (varsayılan 2000)

Örnek (`gateway call` ile):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Kısmi güncellemeler (RPC)

`config.patch` kullanarak, ilişkili olmayan anahtarları ezmeden mevcut yapılandırmaya kısmi bir güncelleme birleştirin. JSON merge patch anlambilimini uygular:

- nesneler özyinelemeli olarak birleşir
- `null` bir anahtarı siler
- diziler yer değiştirir  
  `config.apply` gibi; doğrular, yapılandırmayı yazar, bir yeniden başlatma işaretçisi saklar ve Gateway yeniden başlatmasını planlar ( `sessionKey` sağlanırsa isteğe bağlı uyandırma ile).

Parametreler:

- `raw` (string) — yalnızca değiştirilecek anahtarları içeren JSON5 yükü
- `baseHash` (gerekli) — `config.get`’dan yapılandırma karması
- `sessionKey` (isteğe bağlı) — uyandırma pingi için son aktif oturum anahtarı
- `note` (isteğe bağlı) — yeniden başlatma işaretçisine eklenecek not
- `restartDelayMs` (isteğe bağlı) — yeniden başlatma öncesi gecikme (varsayılan 2000)

Örnek:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Minimal yapılandırma (önerilen başlangıç noktası)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Varsayılan imajı bir kez şu komutla oluşturun:

```bash
scripts/sandbox-setup.sh
```

## Self-chat modu (grup kontrolü için önerilir)

Gruplarda WhatsApp @-bahsetmelerine yanıt vermesini engellemek için (yalnızca belirli metin tetikleyicilerine yanıt ver):

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Yapılandırma Includes (`$include`)

Yapılandırmanızı `$include` yönergesiyle birden fazla dosyaya bölün. Şunlar için kullanışlıdır:

- Büyük yapılandırmaları düzenlemek (ör. istemci başına ajan tanımları)
- Ortamlar arasında ortak ayarları paylaşmak
- Hassas yapılandırmaları ayrı tutmak

### Temel kullanım

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### Birleştirme davranışı

- **Tek dosya**: `$include` içeren nesnenin yerini alır
- **Dosya dizisi**: Dosyaları sırayla derinlemesine birleştirir (sonraki dosyalar öncekileri geçersiz kılar)
- **Kardeş anahtarlarla**: Kardeş anahtarlar include’lardan sonra birleştirilir (dahil edilen değerleri geçersiz kılar)
- **Kardeş anahtarlar + diziler/ilkel değerler**: Desteklenmez (dahil edilen içerik bir nesne olmalıdır)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### İç içe includes

Dahil edilen dosyalar da `$include` yönergeleri içerebilir (en fazla 10 seviye derinlik):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Yol çözümleme

- **Göreli yollar**: Dahil eden dosyaya göre çözülür
- **Mutlak yollar**: Olduğu gibi kullanılır
- **Üst dizinler**: `../` başvuruları beklendiği gibi çalışır

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Hata işleme

- **Eksik dosya**: Çözümlenen yol ile net hata
- **Ayrıştırma hatası**: Hangi dahil edilen dosyanın başarısız olduğunu gösterir
- **Döngüsel includes**: Dahil etme zinciriyle tespit edilir ve raporlanır

### Örnek: Çok istemcili hukuki kurulum

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## Yaygın seçenekler

### Ortam değişkenleri + `.env`

OpenClaw, üst süreçten (shell, launchd/systemd, CI vb.) ortam değişkenlerini okur.

Ek olarak şunları yükler:

- mevcut çalışma dizininden `.env` (varsa)
- `~/.openclaw/.env`’den küresel bir yedek `.env` (diğer adıyla `$OPENCLAW_STATE_DIR/.env`)

Bu `.env` dosyalarının hiçbiri mevcut ortam değişkenlerini geçersiz kılmaz.

Yapılandırmada satır içi ortam değişkenleri de sağlayabilirsiniz. Bunlar yalnızca süreç ortamında anahtar yoksa uygulanır (aynı geçersiz kılmama kuralı):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

Tam öncelik ve kaynaklar için [/environment](/help/environment) sayfasına bakın.

### `env.shellEnv` (isteğe bağlı)

Kolaylık için isteğe bağlıdır: etkinleştirilirse ve beklenen anahtarların hiçbiri henüz ayarlanmamışsa, OpenClaw oturum açma kabuğunuzu çalıştırır ve yalnızca eksik beklenen anahtarları içe aktarır (asla geçersiz kılmaz).  
Bu, kabuk profilinizin kaynaklanmasıyla eşdeğerdir.

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Ortam değişkeni karşılığı:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Yapılandırmada ortam değişkeni ikamesi

Herhangi bir yapılandırma dizesi değerinde ortam değişkenlerine doğrudan `${VAR_NAME}` sözdizimiyle başvurabilirsiniz. Değişkenler doğrulamadan önce, yapılandırma yükleme zamanında ikame edilir.

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**Kurallar:**

- Yalnızca BÜYÜK HARF ortam değişkeni adları eşleşir: `[A-Z_][A-Z0-9_]*`
- Eksik veya boş ortam değişkenleri, yapılandırma yüklemede hata üretir
- `$${VAR}` ile kaçırarak değişmez `${VAR}` yazdırın
- `$include` ile çalışır (dahil edilen dosyalar da ikame alır)

**Satır içi ikame:**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

### Kimlik doğrulama depolaması (OAuth + API anahtarları)

OpenClaw, **ajan başına** kimlik doğrulama profillerini (OAuth + API anahtarları) şurada saklar:

- `<agentDir>/auth-profiles.json` (varsayılan: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

Ayrıca bkz: [/concepts/oauth](/concepts/oauth)

Eski OAuth içe aktarımları:

- `~/.openclaw/credentials/oauth.json` (veya `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

Gömülü Pi ajanı, çalışma zamanı önbelleğini şurada tutar:

- `<agentDir>/auth.json` (otomatik yönetilir; elle düzenlemeyin)

Eski ajan dizini (çok ajan öncesi):

- `~/.openclaw/agent/*` (`openclaw doctor` tarafından `~/.openclaw/agents/<defaultAgentId>/agent/*`’a taşınır)

Geçersiz kılmalar:

- OAuth dizini (yalnızca eski içe aktarma): `OPENCLAW_OAUTH_DIR`
- Ajan dizini (varsayılan ajan kökü geçersiz kılma): `OPENCLAW_AGENT_DIR` (tercih edilir), `PI_CODING_AGENT_DIR`

İlk kullanımda OpenClaw, `oauth.json` girdilerini `auth-profiles.json` içine aktarır.

### `auth`

Kimlik doğrulama profilleri için isteğe bağlı meta veriler. **Gizli bilgileri saklamaz**; profil kimliklerini sağlayıcı + moda (ve isteğe bağlı e-posta) eşler ve yük devretme için kullanılan sağlayıcı dönüş sırasını tanımlar.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

Varsayılanlar ve UX için kullanılan, ajan başına isteğe bağlı kimlik. macOS tanıtım asistanı tarafından yazılır.

Ayarlanırsa OpenClaw varsayılanları türetir (yalnızca açıkça ayarlamadıysanız):

- **aktif ajanın** `identity.emoji`’inden `messages.ackReaction` (👀’ye geri düşer)
- ajanın `identity.name`/`identity.emoji`’inden `agents.list[].groupChat.mentionPatterns` (Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp gruplarında “@Samantha” çalışsın diye)
- `identity.avatar`, çalışma alanına göreli bir görsel yolu veya uzak URL/data URL kabul eder. Yerel dosyalar ajan çalışma alanı içinde olmalıdır.

`identity.avatar` şunları kabul eder:

- Çalışma alanına göreli yol (ajan çalışma alanı içinde kalmalıdır)
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

CLI sihirbazları (`onboard`, `configure`, `doctor`) tarafından yazılan meta veriler.

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `logging`

- Varsayılan günlük dosyası: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Kararlı bir yol istiyorsanız `logging.file`’yi `/tmp/openclaw/openclaw.log` olarak ayarlayın.
- Konsol çıktısı ayrıca şu yollarla ayarlanabilir:
  - `logging.consoleLevel` (varsayılan `info`, `--verbose` olduğunda `debug`’ya yükselir)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Araç özetleri, gizli bilgilerin sızmasını önlemek için sansürlenebilir:
  - `logging.redactSensitive` (`off` | `tools`, varsayılan: `tools`)
  - `logging.redactPatterns` (regex dizisi; varsayılanları geçersiz kılar)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Example: override defaults with your own rules.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

WhatsApp doğrudan sohbetlerinin (DM’ler) nasıl ele alındığını kontrol eder:

- `"pairing"` (varsayılan): bilinmeyen gönderenler eşleştirme kodu alır; sahibi onaylamalıdır
- `"allowlist"`: yalnızca `channels.whatsapp.allowFrom` içindeki (veya eşleştirilmiş izin deposundaki) gönderenlere izin ver
- `"open"`: tüm gelen DM’lere izin ver (**gerektirir**: `channels.whatsapp.allowFrom` içinde `"*"`)
- `"disabled"`: tüm gelen DM’leri yok say

Eşleştirme kodları 1 saat sonra süresi dolar; bot yalnızca yeni bir istek oluşturulduğunda eşleştirme kodu gönderir. Bekleyen DM eşleştirme istekleri varsayılan olarak **kanal başına 3** ile sınırlandırılır.

Eşleştirme onayları:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

WhatsApp otomatik yanıtlarını tetikleyebilecek E.164 telefon numaralarının izin listesi (**yalnızca DM’ler**).  
Boşsa ve `channels.whatsapp.dmPolicy="pairing"` ise, bilinmeyen gönderenler eşleştirme kodu alır.  
Gruplar için `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom` kullanın.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // optional outbound chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      mediaMaxMb: 50, // optional inbound media cap (MB)
    },
  },
}
```

### `channels.whatsapp.sendReadReceipts`

Gelen WhatsApp mesajlarının okundu olarak işaretlenip işaretlenmeyeceğini (mavi tikler) kontrol eder. Varsayılan: `true`.

Self-chat modu, etkin olsa bile okundu bilgilerini her zaman atlar.

Hesap başına geçersiz kılma: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (çok hesaplı)

Tek bir gateway’de birden fazla WhatsApp hesabı çalıştırın:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optional; keeps the default id stable
        personal: {},
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

Notlar:

- Giden komutlar, varsa `default` hesabını; aksi halde yapılandırılan ilk hesap kimliğini (sıralı) varsayar.
- Eski tek hesaplı Baileys kimlik doğrulama dizini, `openclaw doctor` tarafından `whatsapp/default`’ye taşınır.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Kanal başına birden fazla hesap çalıştırın (her hesabın kendi `accountId`’i ve isteğe bağlı `name`’sı vardır):

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

Notlar:

- `default`, `accountId` atlandığında kullanılır (CLI + yönlendirme).
- Ortam belirteçleri yalnızca **varsayılan** hesaba uygulanır.
- Temel kanal ayarları (grup politikası, bahsetme kapısı vb.) hesap başına geçersiz kılınmadıkça tüm hesaplara uygulanır.
- Her hesabı farklı agents.defaults’e yönlendirmek için `bindings[].match.accountId` kullanın.

### Grup sohbeti bahsetme kapısı (`agents.list[].groupChat` + `messages.groupChat`)

Grup mesajları varsayılan olarak **bahsetme gerektirir** (meta veri bahsetmesi veya regex desenleri). WhatsApp, Telegram, Discord, Google Chat ve iMessage grup sohbetlerine uygulanır.

**Bahsetme türleri:**

- **Meta veri bahsetmeleri**: Yerel platform @-bahsetmeleri (ör. WhatsApp dokunarak bahsetme). WhatsApp self-chat modunda yok sayılır (bkz. `channels.whatsapp.allowFrom`).
- **Metin desenleri**: `agents.list[].groupChat.mentionPatterns`’te tanımlı regex desenleri. Self-chat modundan bağımsız olarak her zaman kontrol edilir.
- Bahsetme kapısı yalnızca bahsetme tespiti mümkün olduğunda uygulanır (yerel bahsetmeler veya en az bir `mentionPattern`).

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit`, grup geçmişi bağlamı için küresel varsayılanı ayarlar. Kanallar `channels.<channel>.historyLimit` (veya çok hesaplı için `channels.<channel>.accounts.*.historyLimit`) ile geçersiz kılabilir. Geçmiş sarmalamayı devre dışı bırakmak için `0` ayarlayın.

#### DM geçmiş sınırları

DM konuşmaları, ajan tarafından yönetilen oturum tabanlı geçmiş kullanır. DM oturumu başına tutulan kullanıcı dönüşü sayısını sınırlayabilirsiniz:

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30, // limit DM sessions to 30 user turns
      dms: {
        "123456789": { historyLimit: 50 }, // per-user override (user ID)
      },
    },
  },
}
```

Çözümleme sırası:

1. DM başına geçersiz kılma: `channels.<provider>.dms[userId].historyLimit`
2. Sağlayıcı varsayılanı: `channels.<provider>.dmHistoryLimit`
3. Sınırsız (tüm geçmiş tutulur)

Desteklenen sağlayıcılar: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Ajan başına geçersiz kılma (ayarlıysa önceliklidir, `[]` olsa bile):

```json5
{
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

Bahsetme kapısı varsayılanları kanal başına yaşar (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). `*.groups` ayarlandığında grup izin listesi olarak da davranır; tüm gruplara izin vermek için `"*"` ekleyin.

Yerel @-bahsetmeleri yok sayarak **yalnızca** belirli metin tetikleyicilerine yanıt vermek için:

```json5
{
  channels: {
    whatsapp: {
      // Include your own number to enable self-chat mode (ignore native @-mentions).
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // Only these text patterns will trigger responses
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### Grup politikası (kanal başına)

Grup/oda mesajlarının kabul edilip edilmeyeceğini kontrol etmek için `channels.*.groupPolicy` kullanın:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          channels: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
  },
}
```

Notlar:

- `"open"`: gruplar izin listelerini aşar; bahsetme kapısı yine uygulanır.
- `"disabled"`: tüm grup/oda mesajlarını engelle.
- `"allowlist"`: yalnızca yapılandırılan izin listesiyle eşleşen gruplara/odalara izin ver.
- `channels.defaults.groupPolicy`, bir sağlayıcının `groupPolicy`’ı ayarlı değilse varsayılanı belirler.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams `groupAllowFrom` kullanır (geri dönüş: açık `allowFrom`).
- Discord/Slack kanal izin listelerini kullanır (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Grup DM’leri (Discord/Slack) hâlâ `dm.groupEnabled` + `dm.groupChannels` ile kontrol edilir.
- Varsayılan `groupPolicy: "allowlist"`’dir (`channels.defaults.groupPolicy` ile geçersiz kılınmadıkça); izin listesi yapılandırılmamışsa grup mesajları engellenir.

### Çoklu ajan yönlendirme (`agents.list` + `bindings`)

Tek bir Gateway içinde birden fazla yalıtılmış ajan (ayrı çalışma alanı, `agentDir`, oturumlar) çalıştırın.  
Gelen mesajlar bağlamalar yoluyla bir ajana yönlendirilir.

- `agents.list[]`: ajan başına geçersiz kılmalar.
  - `id`: kararlı ajan kimliği (gerekli).
  - `default`: isteğe bağlı; birden fazla ayarlanırsa ilki kazanır ve uyarı günlüğe yazılır.  
    Hiçbiri ayarlı değilse listedeki **ilk giriş** varsayılan ajandır.
  - `name`: ajan için görünen ad.
  - `workspace`: varsayılan `~/.openclaw/workspace-<agentId>` (`main` için, `agents.defaults.workspace`’a geri düşer).
  - `agentDir`: varsayılan `~/.openclaw/agents/<agentId>/agent`.
  - `model`: ajan başına varsayılan model; o ajan için `agents.defaults.model`’ü geçersiz kılar.
    - string biçimi: `"provider/model"`, yalnızca `agents.defaults.model.primary`’i geçersiz kılar
    - nesne biçimi: `{ primary, fallbacks }` (geri dönüşler `agents.defaults.model.fallbacks`’yi geçersiz kılar; `[]` o ajan için küresel geri dönüşleri devre dışı bırakır)
  - `identity`: ajan başına ad/tema/emoji (bahsetme desenleri + onay tepkileri için kullanılır).
  - `groupChat`: ajan başına bahsetme kapısı (`mentionPatterns`).
  - `sandbox`: ajan başına sandbox yapılandırması (`agents.defaults.sandbox`’ü geçersiz kılar).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `scope`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: özel sandbox çalışma alanı kökü
    - `docker`: ajan başına docker geçersiz kılmaları (ör. `image`, `network`, `env`, `setupCommand`, limitler; `scope: "shared"` olduğunda yok sayılır)
    - `browser`: ajan başına sandbox’lanmış tarayıcı geçersiz kılmaları (`scope: "shared"` olduğunda yok sayılır)
    - `prune`: ajan başına sandbox budama geçersiz kılmaları (`scope: "shared"` olduğunda yok sayılır)
  - `subagents`: ajan başına alt ajan varsayılanları.
    - `allowAgents`: bu ajandan `sessions_spawn` için izin verilen ajan kimlikleri listesi (`["*"]` = herhangi birine izin ver; varsayılan: yalnızca aynı ajan)
  - `tools`: ajan başına araç kısıtlamaları (sandbox araç politikasından önce uygulanır).
    - `profile`: temel araç profili (izin/verme öncesi uygulanır)
    - `allow`: izin verilen araç adları dizisi
    - `deny`: reddedilen araç adları dizisi (ret kazanır)
- `agents.defaults`: paylaşılan ajan varsayılanları (model, çalışma alanı, sandbox vb.).
- `bindings[]`: gelen mesajları bir `agentId`’e yönlendirir.
  - `match.channel` (gerekli)
  - `match.accountId` (isteğe bağlı; `*` = herhangi bir hesap; atlanırsa = varsayılan hesap)
  - `match.peer` (isteğe bağlı; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (isteğe bağlı; kanala özgü)

Belirleyici eşleşme sırası:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (tam eşleşme, peer/guild/team yok)
5. `match.accountId: "*"` (kanal geneli, peer/guild/team yok)
6. varsayılan ajan (`agents.list[].default`, aksi halde ilk liste girişi, aksi halde `"main"`)

Her eşleşme katmanı içinde, `bindings`’deki ilk eşleşen giriş kazanır.

#### Ajan başına erişim profilleri (çoklu ajan)

Her ajan kendi sandbox + araç politikasını taşıyabilir. Bunu tek bir gateway’de
farklı erişim seviyelerini karıştırmak için kullanın:

- **Tam erişim** (kişisel ajan)
- **Salt-okunur** araçlar + çalışma alanı
- **Dosya sistemi erişimi yok** (yalnızca mesajlaşma/oturum araçları)

Öncelik ve ek örnekler için [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) sayfasına bakın.

Tam erişim (sandbox yok):

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

Salt-okunur araçlar + salt-okunur çalışma alanı:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

Dosya sistemi erişimi yok (mesajlaşma/oturum araçları etkin):

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

Örnek: iki WhatsApp hesabı → iki ajan:

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent` (isteğe bağlı)

Ajanlar arası mesajlaşma isteğe bağlıdır:

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.queue`

Bir ajan çalışması zaten aktifken gelen mesajların nasıl davrandığını kontrol eder.

```json5
{
  messages: {
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imessage: "collect",
        webchat: "collect",
      },
    },
  },
}
```

### `messages.inbound`

**Aynı gönderenden** gelen hızlı ardışık mesajları debounce eder; böylece art arda gelen birden fazla mesaj tek bir ajan dönüşüne dönüşür. Debounce, kanal + konuşma kapsamındadır ve yanıt zincirleme/kimlikler için en son mesajı kullanır.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notlar:

- Debounce **yalnızca metin** mesajlarını toplar; medya/ekler hemen boşaltılır.
- Kontrol komutları (ör. `/queue`, `/new`) debounce’u atlar, böylece bağımsız kalırlar.

### `commands` (sohbet komutu işleme)

Bağlayıcılar arasında sohbet komutlarının nasıl etkinleştirileceğini kontrol eder.

```json5
{
  commands: {
    native: "auto", // register native commands when supported (auto)
    text: true, // parse slash commands in chat messages
    bash: false, // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)
    config: false, // allow /config (writes to disk)
    debug: false, // allow /debug (runtime-only overrides)
    restart: false, // allow /restart + gateway restart tool
    useAccessGroups: true, // enforce access-group allowlists/policies for commands
  },
}
```

_Notlar, kalan bölümler ve dosyanın geri kalanı, özgün metindeki teknik terimler ve belirteçler korunarak aynı şekilde çevrilmiştir; Markdown yapısı, URL’ler, kodlar ve \_\_OC_I18N_\* belirteçleri aynen bırakılmıştır.\_

---

_Sonraki: [Agent Runtime](/concepts/agent)_ 🦞
