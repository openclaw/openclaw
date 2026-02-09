---
summary: "~/.openclaw/openclaw.json için tüm yapılandırma seçenekleri ve örnekler"
read_when:
  - Yapılandırma alanlarını eklerken veya değiştirirken
title: "Yapılandırma"
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

- objects merge recursively
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

### Env vars + `.env`

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

Env var equivalent:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Env var substitution in config

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
- Missing or empty env vars throw an error at config load
- `$${VAR}` ile kaçırarak değişmez `${VAR}` yazdırın
- `$include` ile çalışır (dahil edilen dosyalar da ikame alır)

**Inline substitution:**

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

Legacy agent dir (pre multi-agent):

- `~/.openclaw/agent/*` (`openclaw doctor` tarafından `~/.openclaw/agents/<defaultAgentId>/agent/*`’a taşınır)

Overrides:

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

Read-only tools + read-only workspace:

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

Notlar:

- Text commands must be sent as a **standalone** message and use the leading `/` (no plain-text aliases).
- `commands.text: false` disables parsing chat messages for commands.
- `commands.native: "auto"` (default) turns on native commands for Discord/Telegram and leaves Slack off; unsupported channels stay text-only.
- Set `commands.native: true|false` to force all, or override per channel with `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool or `"auto"`). `false` clears previously registered commands on Discord/Telegram at startup; Slack commands are managed in the Slack app.
- `channels.telegram.customCommands` adds extra Telegram bot menu entries. Names are normalized; conflicts with native commands are ignored.
- `commands.bash: true` enables `! <cmd>` to run host shell commands (`/bash <cmd>` also works as an alias). Requires `tools.elevated.enabled` and allowlisting the sender in `tools.elevated.allowFrom.<channel>` altında yer alır.
- `commands.bashForegroundMs` controls how long bash waits before backgrounding. While a bash job is running, new `! <cmd>` istekleri reddedilir (aynı anda bir tane).
- `commands.config: true` enables `/config` (reads/writes `openclaw.json`).
- `channels.<provider>.configWrites` gates config mutations initiated by that channel (default: true). This applies to `/config set|unset` plus provider-specific auto-migrations (Telegram supergroup ID changes, Slack channel ID changes).
- `commands.debug: true` enables `/debug` (runtime-only overrides).
- `commands.restart: true` enables `/restart` and the gateway tool restart action.
- `commands.useAccessGroups: false` allows commands to bypass access-group allowlists/policies.
- Slash komutları ve yönergeler yalnızca **yetkili gönderenler** için geçerlidir. Authorization is derived from
  channel allowlists/pairing plus `commands.useAccessGroups`.

### `web` (WhatsApp web channel runtime)

WhatsApp runs through the gateway’s web channel (Baileys Web). It starts automatically when a linked session exists.
Set `web.enabled: false` to keep it off by default.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram` (bot transport)

OpenClaw starts Telegram only when a `channels.telegram` config section exists. The bot token is resolved from `channels.telegram.botToken` (or `channels.telegram.tokenFile`), with `TELEGRAM_BOT_TOKEN` as a fallback for the default account.
Set `channels.telegram.enabled: false` to disable automatic startup.
Multi-account support lives under `channels.telegram.accounts` (see the multi-account section above). Env tokens only apply to the default account.
Set `channels.telegram.configWrites: false` to block Telegram-initiated config writes (including supergroup ID migrations and `/config set|unset`).

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // include last N group messages as context (0 disables)
      replyToMode: "first", // off | first | all
      linkPreview: true, // toggle outbound link previews
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {
        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // transport overrides
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

Draft streaming notes:

- Uses Telegram `sendMessageDraft` (draft bubble, not a real message).
- Requires **private chat topics** (message_thread_id in DMs; bot has topics enabled).
- `/reasoning stream` streams reasoning into the draft, then sends the final answer.
  Retry policy defaults and behavior are documented in [Retry policy](/concepts/retry).

### `channels.discord` (bot transport)

Configure the Discord bot by setting the bot token and optional gating:
Multi-account support lives under `channels.discord.accounts` (see the multi-account section above). Env tokens only apply to the default account.

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // clamp inbound media size
      allowBots: false, // allow bot-authored messages
      actions: {
        // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // disable all DMs when false
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false, // enable group DMs
        groupChannels: ["openclaw-dm"], // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (preferred) or slug
          slug: "friends-of-openclaw",
          requireMention: false, // per-guild default
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // include last N guild messages as context
      textChunkLimit: 2000, // optional outbound text chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

OpenClaw starts Discord only when a `channels.discord` config section exists. The token is resolved from `channels.discord.token`, with `DISCORD_BOT_TOKEN` as a fallback for the default account (unless `channels.discord.enabled` is `false`). Use `user:<id>` (DM) or `channel:<id>` (guild channel) when specifying delivery targets for cron/CLI commands; bare numeric IDs are ambiguous and rejected.
Guild slugs are lowercase with spaces replaced by `-`; channel keys use the slugged channel name (no leading `#`). Prefer guild ids as keys to avoid rename ambiguity.
Bot-authored messages are ignored by default. Enable with `channels.discord.allowBots` (own messages are still filtered to prevent self-reply loops).
Reaction notification modes:

- `off`: tepki olayı yok.
- `own`: botun kendi mesajlarındaki tepkiler (varsayılan).
- `all`: tüm mesajlardaki tüm tepkiler.
- `allowlist`: `guilds.<id>.users`’ten gelen tepkiler tüm mesajlarda (boş liste devre dışı bırakır).
  Giden metin `channels.discord.textChunkLimit` (varsayılan 2000) tarafından parçalara bölünür. Set `channels.discord.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking. Discord clients can clip very tall messages, so `channels.discord.maxLinesPerMessage` (default 17) splits long multi-line replies even when under 2000 chars.
  Retry policy defaults and behavior are documented in [Retry policy](/concepts/retry).

### `channels.googlechat` (Chat API webhook)

Google Chat, uygulama düzeyinde kimlik doğrulama (servis hesabı) ile HTTP webhook’lar üzerinden çalışır.
Çoklu hesap desteği `channels.googlechat.accounts` altında bulunur (yukarıdaki çoklu hesap bölümüne bakın). Ortam değişkenleri yalnızca varsayılan hesap için geçerlidir.

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; improves mention detection
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notlar:

- Servis hesabı JSON’u satır içi (`serviceAccount`) veya dosya tabanlı (`serviceAccountFile`) olabilir.
- Varsayılan hesap için ortam değişkeni geri dönüşleri: `GOOGLE_CHAT_SERVICE_ACCOUNT` veya `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience`, Chat uygulamasının webhook kimlik doğrulama yapılandırmasıyla eşleşmelidir.
- Teslim hedeflerini ayarlarken `spaces/<spaceId>` veya `users/<userId|email>` kullanın.

### `channels.slack` (socket mode)

Slack Socket Modunda çalışır ve hem bot belirteci hem de uygulama belirteci gerektirir:

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

Çoklu hesap desteği `channels.slack.accounts` altında bulunur (yukarıdaki çoklu hesap bölümüne bakın). Ortam token’ları yalnızca varsayılan hesap için geçerlidir.

OpenClaw, sağlayıcı etkinleştirildiğinde ve her iki token da ayarlandığında Slack’i başlatır (yapılandırma yoluyla veya `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Cron/CLI komutları için teslim hedeflerini belirtirken `user:<id>` (DM) veya `channel:<id>` kullanın.
Slack tarafından başlatılan yapılandırma yazımlarını engellemek için `channels.slack.configWrites: false` ayarlayın (kanal ID geçişleri ve `/config set|unset` dahil).

Bot tarafından yazılan mesajlar varsayılan olarak yok sayılır. `channels.slack.allowBots` veya `channels.slack.channels.<id>` ile etkinleştirin..allowBots\` ile etkinleştirin.

Tepki bildirim modları:

- `off`: tepki olayı yok.
- `own`: botun kendi mesajlarındaki tepkiler (varsayılan).
- `all`: tüm mesajlardaki tüm tepkiler.
- `allowlist`: tüm mesajlarda `channels.slack.reactionAllowlist` içindeki kullanıcılardan gelen tepkiler (boş liste devre dışı bırakır).

Thread oturum yalıtımı:

- `channels.slack.thread.historyScope`, thread geçmişinin thread başına (`thread`, varsayılan) mı yoksa kanal genelinde (`channel`) mi olacağını kontrol eder.
- `channels.slack.thread.inheritParent`, yeni thread oturumlarının üst kanal dökümünü devralıp devralmayacağını kontrol eder (varsayılan: false).

Slack eylem grupları (`slack` araç eylemlerini kapıdan geçirir):

| Eylem grubu | Varsayılan | Notes                      |
| ----------- | ---------- | -------------------------- |
| reactions   | etkin      | Tepki ekle + listele       |
| messages    | etkin      | Oku/gönder/düzenle/sil     |
| pins        | etkin      | Pinle/pinden çıkar/listele |
| memberInfo  | etkin      | Üye bilgisi                |
| emojiList   | etkin      | Özel emoji listesi         |

### `channels.mattermost` (bot belirteci)

Mattermost bir eklenti olarak gelir ve çekirdek kurulumla birlikte gelmez.
Önce kurun: `openclaw plugins install @openclaw/mattermost` (veya bir git checkout’tan `./extensions/mattermost`).

Mattermost, bir bot token’ına ek olarak sunucunuz için temel URL’yi gerektirir:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClaw, hesap yapılandırıldığında (bot token’ı + temel URL) ve etkinleştirildiğinde Mattermost’u başlatır. Token + temel URL, varsayılan hesap için `channels.mattermost.botToken` + `channels.mattermost.baseUrl` veya `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` üzerinden çözülür (`channels.mattermost.enabled` `false` olmadığı sürece).

Sohbet modları:

- `oncall` (varsayılan): yalnızca @bahsedildiğinde kanal mesajlarına yanıt verir.
- `onmessage`: her kanal mesajına yanıt verir.
- `onchar`: bir mesaj tetikleyici bir önekle başladığında yanıt verir (`channels.mattermost.oncharPrefixes`, varsayılan `[">", "!"]`).

Erişim kontrolü:

- Varsayılan DM’ler: `channels.mattermost.dmPolicy="pairing"` (bilinmeyen gönderenler bir eşleştirme kodu alır).
- Herkese açık DM'ler: `channels.mattermost.dmPolicy="open"` artı `channels.mattermost.allowFrom=["*"]`.
- Gruplar: `channels.mattermost.groupPolicy="allowlist"` varsayılandır (mention ile kapılı). Gönderenleri kısıtlamak için `channels.mattermost.groupAllowFrom` kullanın.

Çoklu hesap desteği `channels.mattermost.accounts` altında bulunur (yukarıdaki çoklu hesap bölümüne bakın). Ortam değişkenleri yalnızca varsayılan hesap için geçerlidir.
Teslim hedeflerini belirtirken `channel:<id>` veya `user:<id>` (veya `@username`) kullanın; yalın ID’ler kanal ID’si olarak değerlendirilir.

### `channels.signal` (signal-cli)

Signal tepkileri sistem olayları üretebilir (paylaşılan tepki araçları):

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // include last N group messages as context (0 disables)
    },
  },
}
```

Tepki bildirim modları:

- `off`: tepki olayı yok.
- `own`: botun kendi mesajlarındaki tepkiler (varsayılan).
- `all`: tüm mesajlardaki tüm tepkiler.
- `allowlist`: tüm mesajlarda `channels.signal.reactionAllowlist` içindeki tepkiler (boş liste devre dışı bırakır).

### `channels.imessage` (imsg CLI)

OpenClaw, `imsg rpc`’yi başlatır (stdio üzerinden JSON-RPC). Daemon veya port gerekmez.

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50, // include last N group messages as context (0 disables)
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

Çoklu hesap desteği `channels.imessage.accounts` altında bulunur (yukarıdaki çoklu hesap bölümüne bakın).

Notlar:

- Requires Full Disk Access to the Messages DB.
- İlk gönderim Mesajlar otomasyon izni isteyecektir.
- Prefer `chat_id:<id>` targets. Use `imsg chats --limit 20` to list chats.
- `channels.imessage.cliPath` can point to a wrapper script (e.g. `ssh` to another Mac that runs `imsg rpc`); use SSH keys to avoid password prompts.
- For remote SSH wrappers, set `channels.imessage.remoteHost` to fetch attachments via SCP when `includeAttachments` is enabled.

Örnek sarmalayıcı:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Aracının dosya işlemleri için kullandığı **tek küresel çalışma alanı dizinini** ayarlar.

Varsayılan: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

If `agents.defaults.sandbox` is enabled, non-main sessions can override this with their
own per-scope workspaces under `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Optional repository root to show in the system prompt’s Runtime line. If unset, OpenClaw
tries to detect a `.git` directory by walking upward from the workspace (and current
working directory). Kullanılabilmesi için yolun mevcut olması gerekir.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

Çalışma alanı önyükleme dosyalarının (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` ve `BOOTSTRAP.md`) otomatik oluşturulmasını devre dışı bırakır.

Use this for pre-seeded deployments where your workspace files come from a repo.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

Kırpılmadan önce sistem istemine enjekte edilen her çalışma alanı önyükleme dosyasının maksimum karakter sayısı.
Varsayılan: `20000`.

When a file exceeds this limit, OpenClaw logs a warning and injects a truncated
head/tail with a marker.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

Sets the user’s timezone for **system prompt context** (not for timestamps in
message envelopes). If unset, OpenClaw uses the host timezone at runtime.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Controls the **time format** shown in the system prompt’s Current Date & Time section.
Default: `auto` (OS preference).

```json5
**Satır içi ikame:**
```

### `mesajlar`

Controls inbound/outbound prefixes and optional ack reactions.
See [Messages](/concepts/messages) for queueing, sessions, and streaming context.

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` is applied to **all outbound replies** (tool summaries, block
streaming, final replies) across channels unless already present.

Overrides can be configured per channel and per account:

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

Çözümleme sırası (en özeli kazanır):

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

Semantics:

- `undefined` falls through to the next level.
- `""` explicitly disables the prefix and stops the cascade.
- `"auto"` derives `[{identity.name}]` for the routed agent.

Overrides apply to all channels, including extensions, and to every outbound reply kind.

If `messages.responsePrefix` is unset, no prefix is applied by default. WhatsApp self-chat
replies are the exception: they default to `[{identity.name}]` when set, otherwise
`[openclaw]`, so same-phone conversations stay legible.
Set it to `"auto"` to derive `[{identity.name}]` for the routed agent (when set).

#### Template variables

The `responsePrefix` string can include template variables that resolve dynamically:

| Değişken          | Açıklama                 | Örnek                                     |
| ----------------- | ------------------------ | ----------------------------------------- |
| `{model}`         | Short model name         | `claude-opus-4-6`, `gpt-4o`               |
| `{modelFull}`     | Tam model tanımlayıcısı  | `anthropic/claude-opus-4-6`               |
| `{provider}`      | Sağlayıcı adı            | `anthropic`, `openai`                     |
| `{thinkingLevel}` | Geçerli düşünme seviyesi | `high`, `low`, `off`                      |
| `{identity.name}` | Ajan kimlik adı          | ("auto" modu ile aynı) |

Değişkenler büyük/küçük harfe duyarsızdır (`{MODEL}` = `{model}`). `{think}` , `{thinkingLevel}` için bir takma addır.
Çözümlenmemiş değişkenler düz metin olarak kalır.

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

Örnek çıktı: `[claude-opus-4-6 | think:high] İşte yanıtım...`

WhatsApp gelen mesaj ön eki `channels.whatsapp.messagePrefix` üzerinden yapılandırılır (kullanımdan kaldırıldı:
`messages.messagePrefix`). Varsayılan **değişmeden** kalır: `"[openclaw]"`,
`channels.whatsapp.allowFrom` boş olduğunda; aksi halde `""` (ön ek yok). `"[openclaw]"` kullanılırken, yönlendirilen ajanın `identity.name` değeri ayarlıysa OpenClaw bunun yerine `[{identity.name}]` kullanır.

`ackReaction`, tepkileri destekleyen kanallarda (Slack/Discord/Telegram/Google Chat) gelen mesajları onaylamak için en iyi çabayla bir emoji tepkisi gönderir. Ayarlıysa varsayılan olarak etkin ajanın `identity.emoji` değeri kullanılır, aksi halde `"👀"`. Devre dışı bırakmak için `""` olarak ayarlayın.

`ackReactionScope`, tepkilerin ne zaman tetikleneceğini kontrol eder:

- `group-mentions` (varsayılan): yalnızca bir grup/oda bahsetme gerektiriyorsa **ve** bot etiketlendiyse
- `group-all`: tüm grup/oda mesajları
- `direct`: yalnızca doğrudan mesajlar
- `all`: tüm mesajlar

`removeAckAfterReply`, bir yanıt gönderildikten sonra botun onay tepkisini kaldırır
(yalnızca Slack/Discord/Telegram/Google Chat). Varsayılan: `false`.

#### `messages.tts`

Giden yanıtlar için metinden konuşmaya (TTS) özelliğini etkinleştirir. Açıkken OpenClaw, ElevenLabs veya OpenAI kullanarak ses üretir ve yanıtlarına ekler. Telegram Opus sesli notları kullanır; diğer kanallar MP3 ses gönderir.

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

Notlar:

- `messages.tts.auto`, otomatik TTS’yi kontrol eder (`off`, `always`, `inbound`, `tagged`).
- `/tts off|always|inbound|tagged`, oturum başına otomatik modu ayarlar (yapılandırmayı geçersiz kılar).
- `messages.tts.enabled` eskidir; doctor bunu `messages.tts.auto`ya taşır.
- `prefsPath`, yerel geçersiz kılmaları (sağlayıcı/sınır/özetleme) saklar.
- `maxTextLength`, TTS girdisi için katı bir üst sınırdır; özetler sığacak şekilde kırpılır.
- `summaryModel`, otomatik özet için `agents.defaults.model.primary` değerini geçersiz kılar.
  - `provider/model` biçimini veya `agents.defaults.models` içinden bir takma adı kabul eder.
- `modelOverrides`, `[[tts:...]]` etiketleri gibi model güdümlü geçersiz kılmaları etkinleştirir (varsayılan olarak açık).
- `/tts limit` ve `/tts summary`, kullanıcı başına özetleme ayarlarını kontrol eder.
- `apiKey` değerleri `ELEVENLABS_API_KEY`/`XI_API_KEY` ve `OPENAI_API_KEY` değerlerine geri düşer.
- `elevenlabs.baseUrl`, ElevenLabs API temel URL’sini geçersiz kılar.
- `elevenlabs.voiceSettings`, `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost` ve `speed` (0.5..2.0) değerlerini destekler.

### `talk`

Talk modu için varsayılanlar (macOS/iOS/Android). Ses kimlikleri ayarlı değilse `ELEVENLABS_VOICE_ID` veya `SAG_VOICE_ID` değerlerine geri düşer.
`apiKey`, ayarlı değilse `ELEVENLABS_API_KEY` değerine (veya ağ geçidinin shell profiline) geri düşer.
`voiceAliases` lets Talk directives use friendly names (e.g. `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

Controls the embedded agent runtime (model/thinking/verbose/timeouts).
`agents.defaults.models` defines the configured model catalog (and acts as the allowlist for `/model`).
`agents.defaults.model.primary` sets the default model; `agents.defaults.model.fallbacks` are global failovers.
`agents.defaults.imageModel` is optional and is **only used if the primary model lacks image input**.
Each `agents.defaults.models` entry can include:

- `alias` (optional model shortcut, e.g. `/opus`).
- `params` (optional provider-specific API params passed through to the model request).

`params` is also applied to streaming runs (embedded agent + compaction). Supported keys today: `temperature`, `maxTokens`. These merge with call-time options; caller-supplied values win. `temperature` is an advanced knob—leave unset unless you know the model’s defaults and need a change.

Örnek:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5.2": {
          params: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Z.AI GLM-4.x models automatically enable thinking mode unless you:

- set `--thinking off`, or
- define `agents.defaults.models["zai/<model>"].params.thinking` yourself.

OpenClaw also ships a few built-in alias shorthands. Defaults only apply when the model
is already present in `agents.defaults.models`:

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

If you configure the same alias name (case-insensitive) yourself, your value wins (defaults never override).

Example: Opus 4.6 primary with MiniMax M2.1 fallback (hosted MiniMax):

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

MiniMax auth: set `MINIMAX_API_KEY` (env) or configure `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI fallback)

Optional CLI backends for text-only fallback runs (no tool calls). These are useful as a
backup path when API providers fail. Image pass-through is supported when you configure
an `imageArg` that accepts file paths.

Notlar:

- CLI backends are **text-first**; tools are always disabled.
- Sessions are supported when `sessionArg` is set; session ids are persisted per backend.
- For `claude-cli`, defaults are wired in. Override the command path if PATH is minimal
  (launchd/systemd).

Örnek:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning` (tool-result pruning)

`agents.defaults.contextPruning` prunes **old tool results** from the in-memory context right before a request is sent to the LLM.
It does **not** modify the session history on disk (`*.jsonl` remains complete).

This is intended to reduce token usage for chatty agents that accumulate large tool outputs over time.

High level:

- Never touches user/assistant messages.
- Protects the last `keepLastAssistants` assistant messages (no tool results after that point are pruned).
- Protects the bootstrap prefix (nothing before the first user message is pruned).
- Modes:
  - `adaptive`: soft-trims oversized tool results (keep head/tail) when the estimated context ratio crosses `softTrimRatio`.
    Ardından, tahmini bağlam oranı `hardClearRatio` eşiğini **ve** yeterli budanabilir araç sonucu hacmi (`minPrunableToolChars`) olduğunda en eski uygun araç sonuçlarını sert şekilde temizler.
  - `aggressive`: kesim noktasından önceki uygun araç sonuçlarını her zaman `hardClear.placeholder` ile değiştirir (oran kontrolü yoktur).

Yumuşak vs sert budama (LLM’ye gönderilen bağlamda ne değişir):

- **Yumuşak-kırpma**: yalnızca _aşırı büyük_ araç sonuçları için. Başlangıç + sonu korur ve ortaya `...` ekler.
  - Önce: `toolResult("…çok uzun çıktı…")`
  - Sonra: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`
- **Sert-temizleme**: tüm araç sonucunu yer tutucu ile değiştirir.
  - Önce: `toolResult("…çok uzun çıktı…")`
  - Sonra: `toolResult("[Old tool result content cleared]")`

Notlar / mevcut sınırlamalar:

- **Görüntü blokları içeren araç sonuçları şu anda atlanır** (asla kırpılmaz/temizlenmez).
- Tahmini “bağlam oranı” **karakterlere** (yaklaşık) dayanır, tam belirteçlere değil.
- Oturum henüz en az `keepLastAssistants` yardımcı mesajı içermiyorsa budama atlanır.
- `aggressive` modunda, `hardClear.enabled` yok sayılır (uygun araç sonuçları her zaman `hardClear.placeholder` ile değiştirilir).

Varsayılan (uyarlamalı):

```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } } },
}
```

Devre dışı bırakmak için:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

Varsayılanlar (`mode` "adaptive" veya "aggressive" olduğunda):

- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (yalnızca adaptive)
- `hardClearRatio`: `0.5` (yalnızca adaptive)
- `minPrunableToolChars`: `50000` (yalnızca adaptive)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (yalnızca uyarlamalı)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Örnek (aggressive, minimal):

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } } },
}
```

Örnek (ayarlanmış adaptive):

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        // İsteğe bağlı: budamayı belirli araçlarla sınırla (deny kazanır; "*" jokerlerini destekler)
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

Davranış ayrıntıları için [/concepts/session-pruning](/concepts/session-pruning) sayfasına bakın.

#### `agents.defaults.compaction` (baş boşluk ayırma + bellek temizleme)

`agents.defaults.compaction.mode` sıkıştırma özetleme stratejisini seçer. Varsayılanı `default`tur; çok uzun geçmişler için parçalı özetlemeyi etkinleştirmek üzere `safeguard` ayarlayın. [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor`, Pi sıkıştırması için minimum `reserveTokens` değerini zorunlu kılar (varsayılan: `20000`). Tabanı devre dışı bırakmak için `0` olarak ayarlayın.

`agents.defaults.compaction.memoryFlush`, otomatik sıkıştırmadan önce **sessiz** bir ajanik tur çalıştırır ve modele kalıcı anıları diske yazmasını söyler (örn. `memory/YYYY-MM-DD.md`). Oturum token tahmini, sıkıştırma sınırının altındaki yumuşak bir eşiği geçtiğinde tetiklenir.

Eski varsayılanlar:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: `NO_REPLY` içeren yerleşik varsayılanlar
- Not: oturum çalışma alanı salt-okunur olduğunda bellek temizleme atlanır
  (`agents.defaults.sandbox.workspaceAccess: "ro"` veya `"none"`).

Örnek (ayarlanmış):

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Akış engelleme:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (varsayılan kapalı).

- Kanal geçersiz kılmaları: akış bloklarını açıp kapatmak için `*.blockStreaming` (ve hesap bazlı varyantlar).
  Telegram dışı kanallar, blok yanıtları etkinleştirmek için açıkça `*.blockStreaming: true` gerektirir.

- `agents.defaults.blockStreamingBreak`: `"text_end"` veya `"message_end"` (varsayılan: text_end).

- `agents.defaults.blockStreamingChunk`: akışlanan bloklar için yumuşak parçalama. Varsayılanlar
  800–1200 karakter, paragraf sonlarını (`\n\n`) tercih eder, ardından yeni satırlar, sonra cümleler.
  Örnek:

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: merge streamed blocks before sending.
  Defaults to `{ idleMs: 1000 }` and inherits `minChars` from `blockStreamingChunk`
  with `maxChars` capped to the channel text limit. Signal/Slack/Discord/Google Chat default
  to `minChars: 1500` unless overridden.
  Channel overrides: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (and per-account variants).

- `agents.defaults.humanDelay`: randomized pause between **block replies** after the first.
  Modes: `off` (default), `natural` (800–2500ms), `custom` (use `minMs`/`maxMs`).
  Per-agent override: `agents.list[].humanDelay`.
  Örnek:

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } } },
  }
  ```

  See [/concepts/streaming](/concepts/streaming) for behavior + chunking details.

Typing indicators:

- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"`. Defaults to
  `instant` for direct chats / mentions and `message` for unmentioned group chats.
- `session.typingMode`: per-session override for the mode.
- `agents.defaults.typingIntervalSeconds`: how often the typing signal is refreshed (default: 6s).
- `session.typingIntervalSeconds`: per-session override for the refresh interval.
  See [/concepts/typing-indicators](/concepts/typing-indicators) for behavior details.

`agents.defaults.model.primary` should be set as `provider/model` (e.g. `anthropic/claude-opus-4-6`).
Takma adlar `agents.defaults.models.*.alias`’tan gelir (örn. `Opus`).
If you omit the provider, OpenClaw currently assumes `anthropic` as a temporary
deprecation fallback.
Z.AI models are available as `zai/<model>` (e.g. `zai/glm-4.7`) and require
`ZAI_API_KEY` (or legacy `Z_AI_API_KEY`) in the environment.

`agents.defaults.heartbeat` configures periodic heartbeat runs:

- `every`: duration string (`ms`, `s`, `m`, `h`); default unit minutes. Default:
  `30m`. Set `0m` to disable.
- `model`: optional override model for heartbeat runs (`provider/model`).
- `includeReasoning`: when `true`, heartbeats will also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`). Default: `false`.
- `session`: optional session key to control which session the heartbeat runs in. Default: `main`.
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp, chat id for Telegram).
- `target`: optional delivery channel (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Default: `last`.
- `prompt`: optional override for the heartbeat body (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Overrides are sent verbatim; include a `Read HEARTBEAT.md` line if you still want the file read.
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery (default: 300).

Per-agent heartbeats:

- Set `agents.list[].heartbeat` to enable or override heartbeat settings for a specific agent.
- If any agent entry defines `heartbeat`, **only those agents** run heartbeats; defaults
  become the shared baseline for those agents.

Heartbeat’ler tam ajan dönüşleri çalıştırır. Shorter intervals burn more tokens; be mindful
of `every`, keep `HEARTBEAT.md` tiny, and/or choose a cheaper `model`.

`tools.exec` configures background exec defaults:

- `backgroundMs`: time before auto-background (ms, default 10000)
- `timeoutSec`: auto-kill after this runtime (seconds, default 1800)
- `cleanupMs`: how long to keep finished sessions in memory (ms, default 1800000)
- `notifyOnExit`: enqueue a system event + request heartbeat when backgrounded exec exits (default true)
- `applyPatch.enabled`: enable experimental `apply_patch` (OpenAI/OpenAI Codex only; default false)
- `applyPatch.allowModels`: optional allowlist of model ids (e.g. `gpt-5.2` or `openai/gpt-5.2`)
  Note: `applyPatch` is only under `tools.exec`.

`tools.web` configures web search + fetch tools:

- `tools.web.search.enabled` (default: true when key is present)
- `tools.web.search.apiKey` (recommended: set via `openclaw configure --section web`, or use `BRAVE_API_KEY` env var)
- `tools.web.search.maxResults` (1–10, default 5)
- `tools.web.search.timeoutSeconds` (varsayılan 30)
- `tools.web.search.cacheTtlMinutes` (varsayılan 15)
- `tools.web.fetch.enabled` (varsayılan true)
- `tools.web.fetch.maxChars` (varsayılan 50000)
- `tools.web.fetch.maxCharsCap` (default 50000; clamps maxChars from config/tool calls)
- `tools.web.fetch.timeoutSeconds` (varsayılan 30)
- `tools.web.fetch.cacheTtlMinutes` (varsayılan 15)
- `tools.web.fetch.userAgent` (isteğe bağlı geçersiz kılma)
- `tools.web.fetch.readability` (default true; disable to use basic HTML cleanup only)
- `tools.web.fetch.firecrawl.enabled` (default true when an API key is set)
- `tools.web.fetch.firecrawl.apiKey` (optional; defaults to `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (default [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (varsayılan true)
- `tools.web.fetch.firecrawl.maxAgeMs` (isteğe bağlı)
- `tools.web.fetch.firecrawl.timeoutSeconds` (isteğe bağlı)

`tools.media` configures inbound media understanding (image/audio/video):

- `tools.media.models`: shared model list (capability-tagged; used after per-cap lists).
- `tools.media.concurrency`: eşzamanlı yetenek çalıştırmalarının azami sayısı (varsayılan 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out switch (default true when models are configured).
  - `prompt`: optional prompt override (image/video append a `maxChars` hint automatically).
  - `maxChars`: max output characters (default 500 for image/video; unset for audio).
  - `maxBytes`: max media size to send (defaults: image 10MB, audio 20MB, video 50MB).
  - `timeoutSeconds`: request timeout (defaults: image 60s, audio 60s, video 120s).
  - `language`: optional audio hint.
  - `attachments`: attachment policy (`mode`, `maxAttachments`, `prefer`).
  - `scope`: optional gating (first match wins) with `match.channel`, `match.chatType`, or `match.keyPrefix`.
  - `models`: ordered list of model entries; failures or oversize media fall back to the next entry.
- Each `models[]` entry:
  - Provider entry (`type: "provider"` or omitted):
    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).
    - `model`: model id override (required for image; defaults to `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` for audio providers, and `gemini-3-flash-preview` for video).
    - `profile` / `preferredProfile`: auth profile selection.
  - CLI entry (`type: "cli"`):
    - `command`: executable to run.
    - `args`: templated args (supports `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `capabilities`: optional list (`image`, `audio`, `video`) to gate a shared entry. Defaults when omitted: `openai`/`anthropic`/`minimax` → image, `google` → image+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` can be overridden per entry.

If no models are configured (or `enabled: false`), understanding is skipped; the model still receives the original attachments.

Provider auth follows the standard model auth order (auth profiles, env vars like `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, or `models.providers.*.apiKey`).

Örnek:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` configures sub-agent defaults:

- `model`: default model for spawned sub-agents (string or `{ primary, fallbacks }`). If omitted, sub-agents inherit the caller’s model unless overridden per agent or per call.
- `maxConcurrent`: max concurrent sub-agent runs (default 1)
- `archiveAfterMinutes`: auto-archive sub-agent sessions after N minutes (default 60; set `0` to disable)
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (deny wins)

`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`:

- `minimal`: yalnızca `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: kısıtlama yok (ayarlanmamış ile aynı)

Ajan bazında geçersiz kılma: `agents.list[].tools.profile`.

Örnek (varsayılan olarak yalnızca mesajlaşma, ayrıca Slack + Discord araçlarına izin ver):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Örnek (kodlama profili, ancak her yerde exec/process’i engelle):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` lets you **further restrict** tools for specific providers (or a single `provider/model`).
Ajan bazında geçersiz kılma: `agents.list[].tools.byProvider`.

Order: base profile → provider profile → allow/deny policies.
Provider keys accept either `provider` (e.g. `google-antigravity`) or `provider/model`
(e.g. `openai/gpt-5.2`).

Örnek (küresel kodlama profilini koru, ancak Google Antigravity için minimal araçlar):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Example (provider/model-specific allowlist):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

`tools.allow` / `tools.deny` configure a global tool allow/deny policy (deny wins).
Matching is case-insensitive and supports `*` wildcards (`"*"` means all tools).
This is applied even when the Docker sandbox is **off**.

Example (disable browser/canvas everywhere):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

Tool groups (shorthands) work in **global** and **per-agent** tool policies:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tüm yerleşik OpenClaw araçları (sağlayıcı eklentileri hariç)

`tools.elevated` controls elevated (host) exec access:

- `enabled`: allow elevated mode (default true)
- `allowFrom`: per-channel allowlists (empty = disabled)
  - `whatsapp`: E.164 numbers
  - `telegram`: chat ids or usernames
  - `discord`: user ids or usernames (falls back to `channels.discord.dm.allowFrom` if omitted)
  - `signal`: E.164 numbers
  - `imessage`: handles/chat ids
  - `webchat`: session ids or usernames

Örnek:

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

Per-agent override (further restrict):

```json5
{
  agents: {
    list: [
      {
        id: "family",
        tools: {
          elevated: { enabled: false },
        },
      },
    ],
  },
}
```

Notlar:

- `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can only further restrict (both must allow).
- `/elevated on|off|ask|full` stores state per session key; inline directives apply to a single message.
- Elevated `exec` runs on the host and bypasses sandboxing.
- Tool policy still applies; if `exec` is denied, elevated cannot be used.

`agents.defaults.maxConcurrent` sets the maximum number of embedded agent runs that can
execute in parallel across sessions. Each session is still serialized (one run
per session key at a time). Varsayılan: 1.

### `agents.defaults.sandbox`

Optional **Docker sandboxing** for the embedded agent. Intended for non-main
sessions so they cannot access your host system.

Details: [Sandboxing](/gateway/sandboxing)

Defaults (if enabled):

- scope: `"agent"` (one container + workspace per agent)
- Debian bookworm-slim based image
- agent workspace access: `workspaceAccess: "none"` (default)
  - `"none"`: use a per-scope sandbox workspace under `~/.openclaw/sandboxes`
- `"ro"`: keep the sandbox workspace at `/workspace`, and mount the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`)
  - `"rw"`: mount the agent workspace read/write at `/workspace`
- otomatik budama: boşta > 24s VEYA yaş > 7g
- tool policy: allow only `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (deny wins)
  - configure via `tools.sandbox.tools`, override per-agent via `agents.list[].tools.sandbox.tools`
  - tool group shorthands supported in sandbox policy: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- optional sandboxed browser (Chromium + CDP, noVNC observer)
- hardening knobs: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

Warning: `scope: "shared"` means a shared container and shared workspace. No
cross-session isolation. Use `scope: "session"` for per-session isolation.

Legacy: `perSession` is still supported (`true` → `scope: "session"`,
`false` → `scope: "shared"`).

`setupCommand` runs **once** after the container is created (inside the container via `sh -lc`).
For package installs, ensure network egress, a writable root FS, and a root user.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Build the default sandbox image once with:

```bash
scripts/sandbox-setup.sh
```

Note: sandbox containers default to `network: "none"`; set `agents.defaults.sandbox.docker.network`
to `"bridge"` (or your custom network) if the agent needs outbound access.

Note: inbound attachments are staged into the active workspace at `media/inbound/*`. With `workspaceAccess: "rw"`, that means files are written into the agent workspace.

Note: `docker.binds` mounts additional host directories; global and per-agent binds are merged.

Build the optional browser image with:

```bash
scripts/sandbox-browser-setup.sh
```

When `agents.defaults.sandbox.browser.enabled=true`, the browser tool uses a sandboxed
Chromium instance (CDP). If noVNC is enabled (default when headless=false),
the noVNC URL is injected into the system prompt so the agent can reference it.
This does not require `browser.enabled` in the main config; the sandbox control
URL is injected per session.

`agents.defaults.sandbox.browser.allowHostControl` (default: false) allows
sandboxed sessions to explicitly target the **host** browser control server
via the browser tool (`target: "host"`). Leave this off if you want strict
sandbox isolation.

Uzaktan kontrol için izin listeleri:

- `allowedControlUrls`: exact control URLs permitted for `target: "custom"`.
- `allowedControlHosts`: hostnames permitted (hostname only, no port).
- `allowedControlPorts`: izin verilen bağlantı noktaları (varsayılanlar: http=80, https=443).
  Varsayılanlar: tüm izin listeleri ayarlanmamıştır (kısıtlama yok). `allowHostControl` defaults to false.

### `models` (custom providers + base URLs)

OpenClaw uses the **pi-coding-agent** model catalog. You can add custom providers
(LiteLLM, local OpenAI-compatible servers, Anthropic proxies, etc.) by writing
`~/.openclaw/agents/<agentId>/agent/models.json` or by defining the same schema inside your
OpenClaw config under `models.providers`.
Sağlayıcı bazında genel bakış + örnekler: [/concepts/model-providers](/concepts/model-providers).

When `models.providers` is present, OpenClaw writes/merges a `models.json` into
`~/.openclaw/agents/<agentId>/agent/` on startup:

- default behavior: **merge** (keeps existing providers, overrides on name)
- Dosya içeriğinin üzerine yazmak için `models.mode: "replace"` ayarlayın

Select the model via `agents.defaults.model.primary` (provider/model).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {},
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen (multi-model proxy)

OpenCode Zen is a multi-model gateway with per-model endpoints. OpenClaw uses
the built-in `opencode` provider from pi-ai; set `OPENCODE_API_KEY` (or
`OPENCODE_ZEN_API_KEY`) from [https://opencode.ai/auth](https://opencode.ai/auth).

Notlar:

- Model refs use `opencode/<modelId>` (example: `opencode/claude-opus-4-6`).
- If you enable an allowlist via `agents.defaults.models`, add each model you plan to use.
- Shortcut: `openclaw onboard --auth-choice opencode-zen`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) — provider alias support

Z.AI models are available via the built-in `zai` provider. Set `ZAI_API_KEY`
in your environment and reference the model by provider/model.

Shortcut: `openclaw onboard --auth-choice zai-api-key`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

Notlar:

- `z.ai/*` and `z-ai/*` are accepted aliases and normalize to `zai/*`.
- If `ZAI_API_KEY` is missing, requests to `zai/*` will fail with an auth error at runtime.
- Example error: `No API key found for provider "zai".`
- Z.AI’s general API endpoint is `https://api.z.ai/api/paas/v4`. GLM coding
  requests use the dedicated Coding endpoint `https://api.z.ai/api/coding/paas/v4`.
  The built-in `zai` provider uses the Coding endpoint. If you need the general
  endpoint, define a custom provider in `models.providers` with the base URL
  override (see the custom providers section above).
- Use a fake placeholder in docs/configs; never commit real API keys.

### Moonshot AI (Kimi)

Use Moonshot's OpenAI-compatible endpoint:

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notlar:

- Set `MOONSHOT_API_KEY` in the environment or use `openclaw onboard --auth-choice moonshot-api-key`.
- Model ref: `moonshot/kimi-k2.5`.
- For the China endpoint, either:
  - Run `openclaw onboard --auth-choice moonshot-api-key-cn` (wizard will set `https://api.moonshot.cn/v1`), or
  - Manually set `baseUrl: "https://api.moonshot.cn/v1"` in `models.providers.moonshot`.

### Kimi Coding

Use Moonshot AI's Kimi Coding endpoint (Anthropic-compatible, built-in provider):

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

Notlar:

- Set `KIMI_API_KEY` in the environment or use `openclaw onboard --auth-choice kimi-code-api-key`.
- Model ref: `kimi-coding/k2p5`.

### Synthetic (Anthropic-compatible)

Use Synthetic's Anthropic-compatible endpoint:

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Notlar:

- Set `SYNTHETIC_API_KEY` or use `openclaw onboard --auth-choice synthetic-api-key`.
- Model ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.
- Base URL should omit `/v1` because the Anthropic client appends it.

### Local models (LM Studio) — recommended setup

See [/gateway/local-models](/gateway/local-models) for the current local guidance. TL;DR: run MiniMax M2.1 via LM Studio Responses API on serious hardware; keep hosted models merged for fallback.

### MiniMax M2.1

Use MiniMax M2.1 directly without LM Studio:

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // Pricing: update in models.json if you need exact cost tracking.
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notlar:

- Set `MINIMAX_API_KEY` environment variable or use `openclaw onboard --auth-choice minimax-api`.
- Available model: `MiniMax-M2.1` (default).
- Update pricing in `models.json` if you need exact cost tracking.

### Cerebras (GLM 4.6 / 4.7)

Use Cerebras via their OpenAI-compatible endpoint:

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

Notlar:

- Use `cerebras/zai-glm-4.7` for Cerebras; use `zai/glm-4.7` for Z.AI direct.
- Set `CEREBRAS_API_KEY` in the environment or config.

Notlar:

- Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Use `authHeader: true` + `headers` for custom auth needs.
- Override the agent config root with `OPENCLAW_AGENT_DIR` (or `PI_CODING_AGENT_DIR`)
  if you want `models.json` stored elsewhere (default: `~/.openclaw/agents/main/agent`).

### `session`

Controls session scoping, reset policy, reset triggers, and where the session store is written.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // Default is already per-agent under ~/.openclaw/agents/<agentId>/sessions/sessions.json
    // You can override with {agentId} templating:
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    // Direct chats collapse to agent:<agentId>:<mainKey> (default: "main").
    mainKey: "main",
    agentToAgent: {
      // Max ping-pong reply turns between requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

Alanlar:

- `mainKey`: direct-chat bucket key (default: `"main"`). Useful when you want to “rename” the primary DM thread without changing `agentId`.
  - Sandbox note: `agents.defaults.sandbox.mode: "non-main"` uses this key to detect the main session. Any session key that does not match `mainKey` (groups/channels) is sandboxed.
- `dmScope`: how DM sessions are grouped (default: `"main"`).
  - `main`: all DMs share the main session for continuity.
  - `per-peer`: isolate DMs by sender id across channels.
  - `per-channel-peer`: isolate DMs per channel + sender (recommended for multi-user inboxes).
  - `per-account-channel-peer`: isolate DMs per account + channel + sender (recommended for multi-account inboxes).
  - Secure DM mode (recommended): set `session.dmScope: "per-channel-peer"` when multiple people can DM the bot (shared inboxes, multi-person allowlists, or `dmPolicy: "open"`).
- `identityLinks`: map canonical ids to provider-prefixed peers so the same person shares a DM session across channels when using `per-peer`, `per-channel-peer`, or `per-account-channel-peer`.
  - Example: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: primary reset policy. Defaults to daily resets at 4:00 AM local time on the gateway host.
  - `mode`: `daily` or `idle` (default: `daily` when `reset` is present).
  - `atHour`: local hour (0-23) for the daily reset boundary.
  - `idleMinutes`: sliding idle window in minutes. Günlük + boşta birlikte yapılandırıldığında, önce süresi dolan kazanır.
- `resetByType`: per-session overrides for `dm`, `group`, and `thread`.
  - If you only set legacy `session.idleMinutes` without any `reset`/`resetByType`, OpenClaw stays in idle-only mode for backward compatibility.
- `heartbeatIdleMinutes`: optional idle override for heartbeat checks (daily reset still applies when enabled).
- `agentToAgent.maxPingPongTurns`: max reply-back turns between requester/target (0–5, default 5).
- `sendPolicy.default`: `allow` or `deny` fallback when no rule matches.
- `sendPolicy.rules[]`: match by `channel`, `chatType` (`direct|group|room`), or `keyPrefix` (e.g. `cron:`). First deny wins; otherwise allow.

### `skills` (skills config)

Controls bundled allowlist, install preferences, extra skill folders, and per-skill
overrides. 2. Ayarlanırsa, yalnızca bu paketlenmiş beceriler uygundur (yönetilen/çalışma alanı becerileri etkilenmez).

Alanlar:

- `allowBundled` — yalnızca **paketlenmiş** skills için isteğe bağlı izin listesi. 3. `install.nodeManager`: node yükleyici tercihi (`npm` | `pnpm` | `yarn`, varsayılan: npm).
- `load.extraDirs`: taranacak ek skill dizinleri (en düşük öncelik).
- `install.preferBrew`: mevcut olduğunda brew yükleyicilerini tercih et (varsayılan: true).
- 4. \`: beceri başına yapılandırma geçersiz kılmaları.
- `entries.<skillKey>5. `apiKey`: birincil bir ortam değişkeni tanımlayan beceriler için isteğe bağlı kolaylık (örn. `nano-banana-pro`→`GEMINI_API_KEY\`).

Skill başına alanlar:

- `enabled`: paketli/kurulu olsa bile bir skill’i devre dışı bırakmak için `false` olarak ayarlayın.
- `env`: ajan çalıştırması için enjekte edilen ortam değişkenleri (yalnızca zaten ayarlı değilse).
- 6. {
     skills: {
     allowBundled: ["gemini", "peekaboo"],
     load: {
     extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
     },
     install: {
     preferBrew: true,
     nodeManager: "npm",
     },
     entries: {
     "nano-banana-pro": {
     apiKey: "GEMINI_KEY_HERE",
     env: {
     GEMINI_API_KEY: "GEMINI_KEY_HERE",
     },
     },
     peekaboo: { enabled: true },
     sag: { enabled: false },
     },
     },
     }

Örnek:

```json5
7. `plugins` (uzantılar)
```

### 8. Eklenti keşfini, izin/verme-engelleme ve eklenti başına yapılandırmayı kontrol eder.

9. Eklentiler `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions` ve ayrıca herhangi bir `plugins.load.paths` girdisinden yüklenir. 10. **Yapılandırma değişiklikleri bir gateway yeniden başlatması gerektirir.**
   Tüm kullanım için [/plugin](/tools/plugin) sayfasına bakın. 11. `enabled`: eklenti yükleme için ana anahtar (varsayılan: true).

Alanlar:

- 12. `allow`: isteğe bağlı eklenti kimliği izin listesi; ayarlanırsa yalnızca listelenen eklentiler yüklenir.
- 13. `deny`: isteğe bağlı eklenti kimliği engelleme listesi (engelleme önceliklidir).
- 14. `load.paths`: yüklenecek ek eklenti dosyaları veya dizinleri (mutlak yol veya `~`).
- 15. \`entries.<pluginId>
- 16. `: eklenti başına geçersiz kılmalar.17. `enabled`: devre dışı bırakmak için `false\` olarak ayarlayın.
  - 18. `config`: eklentiye özgü yapılandırma nesnesi (sağlanırsa eklenti tarafından doğrulanır).
  - 19. {
        plugins: {
        enabled: true,
        allow: ["voice-call"],
        load: {
        paths: ["~/Projects/oss/voice-call-extension"],
        },
        entries: {
        "voice-call": {
        enabled: true,
        config: {
        provider: "twilio",
        },
        },
        },
        },
        }

Örnek:

```json5
20. `browser` (openclaw tarafından yönetilen tarayıcı)
```

### 21. OpenClaw, openclaw için **özel ve yalıtılmış** bir Chrome/Brave/Edge/Chromium örneği başlatabilir ve küçük bir loopback kontrol servisi sunar.

22. Profiller, `profiles.<name>` aracılığıyla **uzak** bir Chromium tabanlı tarayıcıyı işaret edebilir
23. `.cdpUrl`.24. Uzak profiller yalnızca bağlanma modundadır (başlat/durdur/sıfırla devre dışıdır). 25. `browser.cdpUrl`, eski tek-profil yapılandırmaları için ve yalnızca `cdpPort` ayarlayan profiller için temel şema/ana makine olarak kalır.

26. enabled: `true`

Varsayılanlar:

- 27. evaluateEnabled: `true` (`act:evaluate` ve `wait --fn`'i devre dışı bırakmak için `false` olarak ayarlayın)
- 28. kontrol servisi: yalnızca loopback (`gateway.port`tan türetilen port, varsayılan `18791`)
- 29. CDP URL: `http://127.0.0.1:18792` (kontrol servisi + 1, eski tek-profil)
- 30. profil rengi: `#FF4500` (lobster-orange)
- 31. Not: kontrol sunucusu çalışan gateway tarafından başlatılır (OpenClaw.app menü çubuğu veya `openclaw gateway`).
- 32. Otomatik algılama sırası: Chromium tabanlıysa varsayılan tarayıcı; aksi halde Chrome → Brave → Edge → Chromium → Chrome Canary.
- 33. {
      browser: {
      enabled: true,
      evaluateEnabled: true,
      // cdpUrl: "http://127.0.0.1:18792", // eski tek-profil geçersiz kılma
      defaultProfile: "chrome",
      profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
      },
      color: "#FF4500",
      // Gelişmiş:
      // headless: false,
      // noSandbox: false,
      // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      // attachOnly: false, // uzak bir CDP'yi localhost'a tünellerken true yapın
      },
      }

```json5
34. `ui` (Görünüm)
```

### `ui` (Görünüm)

Yerel uygulamalar tarafından UI kromu için kullanılan isteğe bağlı vurgu rengi (örn. Konuşma Modu balon tonu).

37. {
    ui: {
    seamColor: "#FF4500", // hex (RRGGBB veya #RRGGBB)
    // İsteğe bağlı: Control UI asistan kimliği geçersiz kılma.
    // Ayarlanmazsa, Control UI etkin ajan kimliğini kullanır (config veya IDENTITY.md).
    assistant: {
    name: "OpenClaw",
    avatar: "CB", // emoji, kısa metin veya resim URL/data URI
    },
    },
    }

```json5
38. `gateway` (Gateway sunucu modu + bağlama)
```

### 39. Bu makinenin Gateway çalıştırıp çalıştırmaması gerektiğini açıkça belirtmek için `gateway.mode` kullanın.

40. mode: **ayarlanmamış** ("otomatik başlatma" olarak değerlendirilir)

Varsayılanlar:

- 41. bind: `loopback`
- 42. port: `18789` (WS + HTTP için tek port)
- 43. {
      gateway: {
      mode: "local", // veya "remote"
      port: 18789, // WS + HTTP çoklama
      bind: "loopback",
      // controlUi: { enabled: true, basePath: "/openclaw" }
      // auth: { mode: "token", token: "your-token" } // token WS + Control UI erişimini sınırlar
      // tailscale: { mode: "off" | "serve" | "funnel" }
      },
      }

```json5
44. Control UI temel yolu:
```

45. `gateway.controlUi.basePath`, Control UI'nin sunulduğu URL önekini ayarlar.

- 46. Örnekler: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- 47. Varsayılan: kök (`/`) (değişmeden).
- 48. `gateway.controlUi.root`, Control UI varlıkları için dosya sistemi kökünü ayarlar (varsayılan: `dist/control-ui`).
- 49. `gateway.controlUi.allowInsecureAuth`, cihaz kimliği atlandığında (genellikle HTTP üzerinden) Control UI için yalnızca token tabanlı kimlik doğrulamaya izin verir.
- 50. Varsayılan: `false`. Default: `false`. Prefer HTTPS
      (Tailscale Serve) or `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` disables device identity checks for the
  Control UI (token/password only). Default: `false`. Yalnızca acil durum (break-glass) için.

İlgili belgeler:

- [Kontrol UI](/web/control-ui)
- [Web overview](/web)
- [Tailscale](/gateway/tailscale)
- [Uzaktan erişim](/gateway/remote)

Güvenilir proxy’ler:

- `gateway.trustedProxies`: list of reverse proxy IPs that terminate TLS in front of the Gateway.
- When a connection comes from one of these IPs, OpenClaw uses `x-forwarded-for` (or `x-real-ip`) to determine the client IP for local pairing checks and HTTP auth/local checks.
- Yalnızca tamamen kontrol ettiğiniz proxy’leri listeleyin ve gelen `x-forwarded-for` değerlerinin **üzerine yazdıklarından** emin olun.

Notlar:

- `openclaw gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).
- `gateway.port` controls the single multiplexed port used for WebSocket + HTTP (control UI, hooks, A2UI).
- OpenAI Chat Completions endpoint: **disabled by default**; enable with `gateway.http.endpoints.chatCompletions.enabled: true`.
- Precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > default `18789`.
- Gateway auth is required by default (token/password or Tailscale Serve identity). Non-loopback binds require a shared token/password.
- The onboarding wizard generates a gateway token by default (even on loopback).
- `gateway.remote.token` is **only** for remote CLI calls; it does not enable local gateway auth. `gateway.token` is ignored.

Auth and Tailscale:

- `gateway.auth.mode` sets the handshake requirements (`token` or `password`). When unset, token auth is assumed.
- `gateway.auth.token` stores the shared token for token auth (used by the CLI on the same machine).
- When `gateway.auth.mode` is set, only that method is accepted (plus optional Tailscale headers).
- `gateway.auth.password` can be set here, or via `OPENCLAW_GATEWAY_PASSWORD` (recommended).
- `gateway.auth.allowTailscale` allows Tailscale Serve identity headers
  (`tailscale-user-login`) to satisfy auth when the request arrives on loopback
  with `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`. OpenClaw
  verifies the identity by resolving the `x-forwarded-for` address via
  `tailscale whois` before accepting it. When `true`, Serve requests do not need
  a token/password; set `false` to require explicit credentials. Defaults to
  `true` when `tailscale.mode = "serve"` and auth mode is not `password`.
- `gateway.tailscale.mode: "serve"` uses Tailscale Serve (tailnet only, loopback bind).
- `gateway.tailscale.mode: "funnel"` exposes the dashboard publicly; requires auth.
- `gateway.tailscale.resetOnExit` resets Serve/Funnel config on shutdown.

Remote client defaults (CLI):

- `gateway.remote.url` sets the default Gateway WebSocket URL for CLI calls when `gateway.mode = "remote"`.
- `gateway.remote.transport` selects the macOS remote transport (`ssh` default, `direct` for ws/wss). When `direct`, `gateway.remote.url` must be `ws://` or `wss://`. `ws://host` defaults to port `18789`.
- `gateway.remote.token` supplies the token for remote calls (leave unset for no auth).
- `gateway.remote.password` supplies the password for remote calls (leave unset for no auth).

macOS app behavior:

- OpenClaw.app watches `~/.openclaw/openclaw.json` and switches modes live when `gateway.mode` or `gateway.remote.url` changes.
- If `gateway.mode` is unset but `gateway.remote.url` is set, the macOS app treats it as remote mode.
- When you change connection mode in the macOS app, it writes `gateway.mode` (and `gateway.remote.url` + `gateway.remote.transport` in remote mode) back to the config file.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Direct transport example (macOS app):

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload` (Config hot reload)

The Gateway watches `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`) and applies changes automatically.

Modlar:

- `hybrid` (default): hot-apply safe changes; restart the Gateway for critical changes.
- `hot`: only apply hot-safe changes; log when a restart is required.
- `restart`: restart the Gateway on any config change.
- `off`: disable hot reload.

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### Hot reload matrisi (dosyalar + etki)

İzlenen dosyalar:

- `~/.openclaw/openclaw.json` (veya `OPENCLAW_CONFIG_PATH`)

Sıcak uygulanır (tam gateway yeniden başlatma yok):

- `hooks` (webhook kimlik doğrulama/yol/eşlemeler) + `hooks.gmail` (Gmail izleyicisi yeniden başlatılır)
- `browser` (tarayıcı kontrol sunucusu yeniden başlatılır)
- `cron` (cron servisi yeniden başlatılır + eşzamanlılık güncellemesi)
- `agents.defaults.heartbeat` (heartbeat çalıştırıcısı yeniden başlatılır)
- `web` (WhatsApp web kanalı yeniden başlatılır)
- `telegram`, `discord`, `signal`, `imessage` (kanal yeniden başlatmaları)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (dinamik okumalar)

Tam Gateway yeniden başlatma gerektirir:

- `gateway` (port/bind/auth/kontrol UI/tailscale)
- `bridge` (legacy)
- `keşif`
- `canvasHost`
- `eklentiler`
- Herhangi bir bilinmeyen/desteklenmeyen yapılandırma yolu (güvenlik için varsayılan olarak yeniden başlatma)

### Çoklu örnek yalıtımı

Tek bir ana makinede birden fazla gateway çalıştırmak için (yedeklilik veya kurtarma botu), örnek başına durum + yapılandırmayı yalıtın ve benzersiz portlar kullanın:

- `OPENCLAW_CONFIG_PATH` (örnek başına yapılandırma)
- `OPENCLAW_STATE_DIR` (oturumlar/kimlik bilgileri)
- `agents.defaults.workspace` (hafızalar)
- `gateway.port` (örnek başına benzersiz)

Kolaylık bayrakları (CLI):

- `openclaw --dev …` → `~/.openclaw-dev` kullanır + portları temel `19001`den kaydırır
- `openclaw --profile <name> …` → `~/.openclaw-<name>` kullanır (port yapılandırma/env/bayraklar üzerinden)

Türetilmiş port eşlemesi (gateway/browser/canvas) için [Gateway runbook](/gateway) sayfasına bakın.
Tarayıcı/CDP port yalıtımı ayrıntıları için [Multiple gateways](/gateway/multiple-gateways) sayfasına bakın.

Örnek:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

### `hooks` (Gateway webhooks)

Gateway HTTP sunucusunda basit bir HTTP webhook uç noktası etkinleştirin.

Varsayılanlar:

- enabled: `false`
- path: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

İstekler hook belirtecini içermelidir:

- `Authorization: Bearer <token>` **veya**
- `x-openclaw-token: <token>`

Uç noktalar:

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds?` }\` döndürür
- `POST /hooks/<name>` → `hooks.mappings` üzerinden çözümlenir

`/hooks/agent` her zaman ana oturuma bir özet gönderir (ve isteğe bağlı olarak `wakeMode: "now"` ile anında bir heartbeat tetikleyebilir).

Eşleme notları:

- `match.path`, `/hooks` sonrasındaki alt yolu eşler (örn. `/hooks/gmail` → `gmail`).
- `match.source`, bir yük alanını eşler (örn. `{ source: "gmail" }`) böylece genel bir `/hooks/ingest` yolu kullanabilirsiniz.
- Templates like `{{messages[0].subject}}` read from the payload.
- `transform`, bir hook eylemi döndüren bir JS/TS modülünü işaret edebilir.
- `deliver: true` nihai yanıtı bir kanala gönderir; `channel` varsayılan olarak `last`tir (WhatsApp’a geri düşer).
- Önceden bir teslim rotası yoksa `channel` + `to` değerlerini açıkça ayarlayın (Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams için gereklidir).
- `model`, bu hook çalıştırması için LLM’i geçersiz kılar (`provider/model` veya takma ad; `agents.defaults.models` ayarlıysa izinli olmalıdır).

Gmail yardımcı yapılandırması (`openclaw webhooks gmail setup` / `run` tarafından kullanılır):

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // İsteğe bağlı: Gmail hook işleme için daha ucuz bir model kullanın
      // Kimlik doğrulama/hız sınırı/zaman aşımında agents.defaults.model.fallbacks, ardından birincile geri düşer
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // İsteğe bağlı: Gmail hook’ları için varsayılan düşünme seviyesi
      thinking: "off",
    },
  },
}
```

Gmail hook’ları için model geçersiz kılma:

- `hooks.gmail.model`, Gmail hook işleme için kullanılacak modeli belirtir (varsayılan: oturumun birincil modeli).
- `agents.defaults.models` içinden `provider/model` referanslarını veya takma adları kabul eder.
- Kimlik doğrulama/hız sınırı/zaman aşımında `agents.defaults.model.fallbacks`, ardından `agents.defaults.model.primary` kullanılır.
- `agents.defaults.models` ayarlıysa, hook modelini allowlist’e ekleyin.
- Başlangıçta, yapılandırılan model model kataloğunda veya allowlist’te yoksa uyarı verir.
- `hooks.gmail.thinking`, Gmail hook’ları için varsayılan düşünme seviyesini ayarlar ve hook başına `thinking` ile geçersiz kılınır.

Gateway auto-start:

- `hooks.enabled=true` ve `hooks.gmail.account` ayarlıysa, Gateway açılışta
  `gog gmail watch serve` başlatır ve izlemeyi otomatik yeniler.
- Otomatik başlatmayı devre dışı bırakmak için `OPENCLAW_SKIP_GMAIL_WATCHER=1` ayarlayın (manuel çalıştırmalar için).
- Gateway ile birlikte ayrı bir `gog gmail watch serve` çalıştırmaktan kaçının; aksi halde
  `listen tcp 127.0.0.1:8788: bind: address already in use` hatasıyla başarısız olur.

Not: `tailscale.mode` açıkken, OpenClaw Tailscale’in `/gmail-pubsub` yolunu doğru şekilde proxy’leyebilmesi için `serve.path` değerini varsayılan olarak `/` yapar (ayarlanan yol önekini kaldırır).
Arka ucun önekli yolu alması gerekiyorsa, `hooks.gmail.tailscale.target` değerini tam bir URL olarak ayarlayın (ve `serve.path` ile hizalayın).

### `canvasHost` (LAN/tailnet Canvas dosya sunucusu + canlı yeniden yükleme)

Gateway, iOS/Android düğümlerinin doğrudan `canvas.navigate` ile erişebilmesi için bir HTML/CSS/JS dizinini HTTP üzerinden sunar.

Varsayılan kök: `~/.openclaw/workspace/canvas`  
Varsayılan port: `18793` (openclaw tarayıcı CDP portu `18792` ile çakışmaması için seçilmiştir)  
Sunucu, düğümlerin erişebilmesi için **gateway bağlama ana makinesinde** (LAN veya Tailnet) dinler.

Sunucu:

- `canvasHost.root` altındaki dosyaları sunar
- sunulan HTML’e küçük bir canlı yeniden yükleme istemcisi enjekte eder
- dizini izler ve `/__openclaw__/ws` adresindeki bir WebSocket uç noktası üzerinden yeniden yüklemeleri yayınlar
- dizin boşken bir başlangıç `index.html` dosyasını otomatik oluşturur (hemen bir şey görmeniz için)
- ayrıca `/__openclaw__/a2ui/` altında A2UI sunar ve düğümlere `canvasHostUrl` olarak ilan edilir
  (Canvas/A2UI için düğümler tarafından her zaman kullanılır)

Dizin büyükse veya `EMFILE` hatasına takılırsanız canlı yeniden yüklemeyi (ve dosya izlemeyi) devre dışı bırakın:

- yapılandırma: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

`canvasHost.*` üzerindeki değişiklikler gateway yeniden başlatması gerektirir (yapılandırma yeniden yüklemesi yeniden başlatır).

Şununla devre dışı bırakın:

- yapılandırma: `canvasHost: { enabled: false }`
- ortam: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (eski TCP köprüsü, kaldırıldı)

Güncel sürümler artık TCP köprüsü dinleyicisini içermez; `bridge.*` yapılandırma anahtarları yok sayılır.
Düğümler Gateway WebSocket üzerinden bağlanır. Bu bölüm tarihsel referans için tutulmuştur.

Eski davranış:

- Gateway, düğümler (iOS/Android) için basit bir TCP köprüsü açabilirdi; genellikle `18790` portunda.

Varsayılanlar:

- etkin: `true`
- port: `18790`
- bind: `lan` (`0.0.0.0`’a bağlanır)

Bağlama modları:

- `lan`: `0.0.0.0` (LAN/Wi‑Fi ve Tailscale dahil tüm arayüzlerden erişilebilir)
- `tailnet`: yalnızca makinenin Tailscale IP’sine bağlanır (Vienna ⇄ London için önerilir)
- `loopback`: `127.0.0.1` (yalnızca yerel)
- `auto`: varsa tailnet IP’yi tercih eder, yoksa `lan`

TLS:

- `bridge.tls.enabled`: köprü bağlantıları için TLS’yi etkinleştirir (etkinleştirildiğinde yalnızca TLS).
- `bridge.tls.autoGenerate`: sertifika/anahtar yoksa kendinden imzalı bir sertifika üretir (varsayılan: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: köprü sertifikası + özel anahtar için PEM yolları.
- `bridge.tls.caPath`: isteğe bağlı PEM CA paketi (özel kökler veya gelecekte mTLS).

TLS etkinleştirildiğinde, Gateway keşif TXT kayıtlarında `bridgeTls=1` ve `bridgeTlsSha256` ilan eder; böylece düğümler sertifikayı sabitleyebilir. Manual connections use trust-on-first-use if no
fingerprint is stored yet.
Auto-generated certs require `openssl` on PATH; if generation fails, the bridge will not start.

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet",
    tls: {
      enabled: true,
      // Uses ~/.openclaw/bridge/tls/bridge-{cert,key}.pem when omitted.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/.openclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (Bonjour / mDNS broadcast mode)

Controls LAN mDNS discovery broadcasts (`_openclaw-gw._tcp`).

- `minimal` (default): omit `cliPath` + `sshPort` from TXT records
- `full`: include `cliPath` + `sshPort` in TXT records
- `off`: disable mDNS broadcasts entirely
- Hostname: defaults to `openclaw` (advertises `openclaw.local`). Override with `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  discovery: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‑SD)

When enabled, the Gateway writes a unicast DNS-SD zone for `_openclaw-gw._tcp` under `~/.openclaw/dns/` using the configured discovery domain (example: `openclaw.internal.`).

To make iOS/Android discover across networks (Vienna ⇄ London), pair this with:

- a DNS server on the gateway host serving your chosen domain (CoreDNS is recommended)
- Tailscale **split DNS** so clients resolve that domain via the gateway DNS server

One-time setup helper (gateway host):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## Media model template variables

Template placeholders are expanded in `tools.media.*.models[].args` and `tools.media.models[].args` (and any future templated argument fields).

\| Variable           | Description                                                                     |
\| ------------------ | ------------------------------------------------------------------------------- | -------- | ------- | ---------- | ----- | ------ | -------- | ------- | ------- | --- |
\| `{{Body}}`         | Full inbound message body                                                       |
\| `{{RawBody}}`      | Raw inbound message body (no history/sender wrappers; best for command parsing) |
\| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents)                     |
\| `{{From}}`         | Sender identifier (E.164 for WhatsApp; may differ per channel)                  |
\| `{{To}}`           | Destination identifier                                                          |
\| `{{MessageSid}}`   | Channel message id (when available)                                             |
\| `{{SessionId}}`    | Current session UUID                                                            |
\| `{{IsNewSession}}` | `"true"` when a new session was created                                         |
\| `{{MediaUrl}}`     | Inbound media pseudo-URL (if present)                                           |
\| `{{MediaPath}}`    | Local media path (if downloaded)                                                |
\| `{{MediaType}}`    | Media type (image/audio/document/…)                                             |
\| `{{Transcript}}`   | Audio transcript (when enabled)                                                 |
\| `{{Prompt}}`       | Resolved media prompt for CLI entries                                           |
\| `{{MaxChars}}`     | Resolved max output chars for CLI entries                                       |
\| `{{ChatType}}`     | `"direct"` or `"group"`                                                         |
\| `{{GroupSubject}}` | Group subject (best effort)                                                     |
\| `{{GroupMembers}}` | Group members preview (best effort)                                             |
\| `{{SenderName}}`   | Sender display name (best effort)                                               |
\| `{{SenderE164}}`   | Sender phone number (best effort)                                               |
\| `{{Provider}}`     | Provider hint (whatsapp                                                         | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …)  |

## Cron (Gateway scheduler)

Cron is a Gateway-owned scheduler for wakeups and scheduled jobs. See [Cron jobs](/automation/cron-jobs) for the feature overview and CLI examples.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_Sonraki: [Agent Runtime](/concepts/agent)_ 🦞
