---
summary: "OpenClaw eklentileri/uzantıları: keşif, yapılandırma ve güvenli kullanım"
read_when:
  - Eklenti/uzantı eklerken veya değiştirirken
  - Eklenti kurulum veya yükleme kurallarını belgelendirirken
title: "Eklentiler"
---

# Eklentiler (Uzantılar)

## 38. Hızlı başlangıç (eklentilere yeni misiniz?)

Bir eklenti, OpenClaw’u ek
özelliklerle (komutlar, araçlar ve Gateway RPC) genişleten **küçük bir kod modülüdür**.

Çoğu zaman, çekirdek OpenClaw’da henüz yerleşik olmayan bir özelliğe
ihtiyacınız olduğunda (ya da isteğe bağlı özellikleri ana kurulumunuzdan ayrı
tutmak istediğinizde) eklentileri kullanırsınız.

Hızlı yol:

1. 39. Zaten yüklü olanları görün:

```bash
openclaw plugins list
```

2. Resmî bir eklenti kurun (örnek: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Gateway’i yeniden başlatın, ardından `plugins.entries.<id>.config` altında yapılandırın.

Somut bir örnek eklenti için [Voice Call](/plugins/voice-call) sayfasına bakın.

## 40. Mevcut eklentiler (resmi)

- Microsoft Teams, 2026.1.15 itibarıyla yalnızca eklenti olarak sunulmaktadır; Teams kullanıyorsanız `@openclaw/msteams`’yi kurun.
- Memory (Core) — paketli bellek arama eklentisi (`plugins.slots.memory` ile varsayılan olarak etkindir)
- Memory (LanceDB) — paketli uzun süreli bellek eklentisi (otomatik geri çağırma/yakalama; `plugins.slots.memory = "memory-lancedb"` ayarlayın)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (sağlayıcı kimlik doğrulaması) — `google-antigravity-auth` olarak paketlidir (varsayılan olarak devre dışı)
- Gemini CLI OAuth (sağlayıcı kimlik doğrulaması) — `google-gemini-cli-auth` olarak paketlidir (varsayılan olarak devre dışı)
- Qwen OAuth (sağlayıcı kimlik doğrulaması) — `qwen-portal-auth` olarak paketlidir (varsayılan olarak devre dışı)
- Copilot Proxy (sağlayıcı kimlik doğrulaması) — yerel VS Code Copilot Proxy köprüsü; yerleşik `github-copilot` cihaz oturum açmadan ayrıdır (paketli, varsayılan olarak devre dışı)

OpenClaw eklentileri, jiti aracılığıyla çalışma zamanında yüklenen **TypeScript modülleridir**. 41. **Yapılandırma
doğrulaması eklenti kodunu çalıştırmaz**; bunun yerine eklenti bildirimi ve JSON
Şemasını kullanır. [Eklenti bildirimi](/plugins/manifest).

Eklentiler şunları kaydedebilir:

- Gateway RPC yöntemleri
- Gateway HTTP işleyicileri
- Ajan araçları
- CLI komutları
- Arka plan servisleri
- İsteğe bağlı yapılandırma doğrulaması
- **Skills** (eklenti bildiriminde `skills` dizinlerini listeleyerek)
- **Otomatik yanıt komutları** (AI ajanını çağırmadan çalışır)

Eklentiler Gateway ile **aynı işlem içinde** çalışır; bu nedenle güvenilir kod olarak değerlendirin.
Araç yazma kılavuzu: [Eklenti ajan araçları](/plugins/agent-tools).

## Çalışma zamanı yardımcıları

Eklentiler, `api.runtime` üzerinden seçili çekirdek yardımcılarına erişebilir. Telefon için TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Notlar:

- Çekirdek `messages.tts` yapılandırmasını kullanır (OpenAI veya ElevenLabs).
- PCM ses arabelleği + örnekleme hızı döndürür. Eklentiler, sağlayıcılar için yeniden örnekleme/kodlama yapmalıdır.
- Edge TTS telefon için desteklenmez.

## Keşif ve öncelik

OpenClaw, şu sırayla tarar:

1. Yapılandırma yolları

- `plugins.load.paths` (dosya veya dizin)

2. Çalışma alanı uzantıları

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Genel uzantılar

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Paketli uzantılar (OpenClaw ile birlikte gönderilir, **varsayılan olarak devre dışıdır**)

- `<openclaw>/extensions/*`

Paketli eklentiler, `plugins.entries.<id>.enabled` veya `openclaw plugins enable <id>` ile açıkça etkinleştirilmelidir. Kurulu eklentiler varsayılan olarak etkindir, ancak aynı şekilde devre dışı bırakılabilir.

Her eklenti kök dizininde bir `openclaw.plugin.json` dosyası bulunmalıdır. Bir yol bir dosyayı işaret ediyorsa, eklenti kökü dosyanın dizinidir ve bildirimi içermelidir.

Birden fazla eklenti aynı id’ye çözülürse, yukarıdaki sırada ilk eşleşme kazanır ve daha düşük öncelikli kopyalar yok sayılır.

### Paket paketleri

Bir eklenti dizini, `openclaw.extensions` içeren bir `package.json` barındırabilir:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Her giriş bir eklentiye dönüşür. Paket birden fazla uzantı listeliyorsa, eklenti id’si `name/<fileBase>` olur.

Eklentiniz npm bağımlılıkları içe aktarıyorsa, bunları o dizine kurun; böylece `node_modules` kullanılabilir (`npm install` / `pnpm install`).

### Kanal katalog meta verileri

Kanal eklentileri, `openclaw.channel` üzerinden katılım meta verilerini ve `openclaw.install` üzerinden kurulum ipuçlarını duyurabilir. Bu, çekirdek kataloğu verisiz tutar.

Örnek:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw ayrıca **harici kanal kataloglarını** birleştirebilir (örneğin bir MPM kayıt defteri dışa aktarımı). Aşağıdakilerden birine bir JSON dosyası bırakın:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Ya da `OPENCLAW_PLUGIN_CATALOG_PATHS`’yı (veya `OPENCLAW_MPM_CATALOG_PATHS`) bir ya da daha fazla JSON dosyasına yönlendirin (virgül/noktalı virgül/`PATH` ile ayrılmış). Her dosya `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` içermelidir.

## Eklenti kimlikleri (ID’ler)

Varsayılan eklenti id’leri:

- Paket paketleri: `package.json` `name`
- Tekil dosya: dosya taban adı (`~/.../voice-call.ts` → `voice-call`)

Bir eklenti `id` dışa aktarıyorsa, OpenClaw bunu kullanır ancak yapılandırılmış id ile eşleşmediğinde uyarır.

## Yapılandırma

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Alanlar:

- `enabled`: ana anahtar (varsayılan: true)
- `allow`: izin listesi (isteğe bağlı)
- `deny`: engelleme listesi (isteğe bağlı; engelleme kazanır)
- `load.paths`: ek eklenti dosyaları/dizinleri
- `entries.<id>`: eklenti başına anahtarlar + yapılandırma

Yapılandırma değişiklikleri **gateway yeniden başlatmayı gerektirir**.

Doğrulama kuralları (katı):

- `entries`, `allow`, `deny` veya `slots` içindeki bilinmeyen eklenti id’leri **hatadır**.
- Bilinmeyen `channels.<id>` anahtarları, eklenti bildirimi kanal id’sini beyan etmedikçe **hatadır**.
- Eklenti yapılandırması, `openclaw.plugin.json` içine gömülü JSON Schema kullanılarak doğrulanır (`configSchema`).
- Bir eklenti devre dışıysa, yapılandırması korunur ve bir **uyarı** üretilir.

## Eklenti yuvaları (özel kategoriler)

Bazı eklenti kategorileri **özeldir** (aynı anda yalnızca biri etkin olabilir). Hangi eklentinin yuvayı sahipleneceğini seçmek için `plugins.slots` kullanın:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Birden fazla eklenti `kind: "memory"` beyan ederse, yalnızca seçilen yüklenir. Diğerleri tanılayıcı bilgilerle devre dışı bırakılır.

## Kontrol UI’si (şema + etiketler)

Kontrol UI’si, daha iyi formlar oluşturmak için `config.schema` (JSON Schema + `uiHints`) kullanır.

OpenClaw, keşfedilen eklentilere göre çalışma zamanında `uiHints`’i zenginleştirir:

- `plugins.entries.<id>` / `.enabled` / `.config` için eklenti başına etiketler ekler
- İsteğe bağlı eklenti tarafından sağlanan yapılandırma alanı ipuçlarını şu altında birleştirir:
  `plugins.entries.<id>.config.<field>`

Eklenti yapılandırma alanlarınızın iyi etiketler/yer tutucular göstermesini (ve gizli değerleri hassas olarak işaretlemesini) istiyorsanız, eklenti bildiriminde JSON Schema’nızın yanında `uiHints` sağlayın.

Örnek:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` yalnızca `plugins.installs` altında izlenen npm kurulumları için çalışır.

Eklentiler ayrıca kendi üst düzey komutlarını da kaydedebilir (örnek: `openclaw voicecall`).

## Eklenti API’si (genel bakış)

42. Eklentiler şunlardan birini dışa aktarır:

- Bir fonksiyon: `(api) => { ... }`
- Bir nesne: `{ id, name, configSchema, register(api) { ... } }`

## 43. Eklenti kancaları

Eklentiler kancalarla birlikte gönderilebilir ve bunları çalışma zamanında kaydedebilir. Bu, ayrı bir kanca paketi kurulumuna gerek kalmadan olay güdümlü otomasyon sağlar.

### Örnek

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notlar:

- Kanca dizinleri normal kanca yapısını izler (`HOOK.md` + `handler.ts`).
- Kanca uygunluk kuralları geçerliliğini korur (OS/binary/ortam/yapılandırma gereksinimleri).
- Eklenti tarafından yönetilen kancalar `openclaw hooks list` içinde `plugin:<id>` ile görünür.
- Eklenti tarafından yönetilen kancaları `openclaw hooks` üzerinden etkinleştirip devre dışı bırakamazsınız; bunun yerine eklentiyi etkinleştirip devre dışı bırakın.

## Sağlayıcı eklentileri (model kimlik doğrulaması)

Eklentiler, kullanıcıların OAuth veya API anahtarı kurulumunu OpenClaw içinde çalıştırabilmesi için **model sağlayıcı kimlik doğrulama** akışları kaydedebilir (harici betik gerekmez).

Bir sağlayıcıyı `api.registerProvider(...)` üzerinden kaydedin. Her sağlayıcı bir
veya daha fazla kimlik doğrulama yöntemi (OAuth, API anahtarı, cihaz kodu vb.) sunar. Bu yöntemler şunları besler:

- `openclaw models auth login --provider <id> [--method <id>]`

Örnek:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

Notlar:

- `run`, `prompter`, `runtime`, `openUrl` ve `oauth.createVpsAwareHandlers` yardımcılarını içeren bir `ProviderAuthContext` alır.
- Varsayılan modelleri veya sağlayıcı yapılandırmasını eklemeniz gerektiğinde `configPatch` döndürün.
- `--set-default`’nin ajan varsayılanlarını güncelleyebilmesi için `defaultModel` döndürün.

### Bir mesajlaşma kanalı kaydetme

Eklentiler, yerleşik kanallar gibi davranan **kanal eklentileri** kaydedebilir (WhatsApp, Telegram vb.). Kanal yapılandırması `channels.<id>` altında yer alır ve kanal eklentisi kodunuz tarafından doğrulanır.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Notlar:

- Yapılandırmayı `channels.<id>` altında tutun (`plugins.entries` altında değil).
- `meta.label`, CLI/UI listelerinde etiketler için kullanılır.
- `meta.aliases`, normalleştirme ve CLI girdileri için alternatif id’ler ekler.
- `meta.preferOver`, her ikisi de yapılandırıldığında otomatik etkinleştirmeyi atlamak için kanal id’lerini listeler.
- `meta.detailLabel` ve `meta.systemImage`, UI’lerin daha zengin kanal etiketleri/simgeleri göstermesini sağlar.

### Yeni bir mesajlaşma kanalı yazma (adım adım)

Bir model sağlayıcı değil, **yeni bir sohbet yüzeyi** (“mesajlaşma kanalı”) istediğinizde bunu kullanın.
Model sağlayıcı belgeleri `/providers/*` altında yer alır.

1. Bir id + yapılandırma şekli seçin

- Tüm kanal yapılandırması `channels.<id>` altında yer alır.
- Çoklu hesap kurulumları için `channels.<id>.accounts.<accountId>`’i tercih edin.

2. Kanal meta verilerini tanımlayın

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` CLI/UI listelerini kontrol eder.
- `meta.docsPath`, `/channels/<id>` gibi bir dokümantasyon sayfasına işaret etmelidir.
- `meta.preferOver`, bir eklentinin başka bir kanalın yerini almasına izin verir (otomatik etkinleştirme onu tercih eder).
- `meta.detailLabel` ve `meta.systemImage`, ayrıntı metni/simgeler için UI’ler tarafından kullanılır.

3. Gerekli bağdaştırıcıları uygulayın

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (sohbet türleri, medya, iş parçacıkları vb.)
- `outbound.deliveryMode` + `outbound.sendText` (temel gönderim için)

4. Gerektikçe isteğe bağlı bağdaştırıcıları ekleyin

- `setup` (sihirbaz), `security` (DM politikası), `status` (sağlık/tanılamalar)
- `gateway` (başlat/durdur/giriş), `mentions`, `threading`, `streaming`
- `actions` (mesaj eylemleri), `commands` (yerel komut davranışı)

5. 44. Eklentinizde kanalı kaydedin

- `api.registerChannel({ plugin })`

Asgari yapılandırma örneği:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

45. Minimal kanal eklentisi (yalnızca giden):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Eklentiyi yükleyin (uzantılar dizini veya `plugins.load.paths`), gateway’i yeniden başlatın,
ardından yapılandırmanızda `channels.<id>`’ü ayarlayın.

### Ajan araçları

Özel kılavuza bakın: [Eklenti ajan araçları](/plugins/agent-tools).

### Bir gateway RPC yöntemi kaydetme

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI komutları kaydetme

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Otomatik yanıt komutları kaydetme

Eklentiler, **AI ajanını çağırmadan** çalışan özel eğik çizgi komutları kaydedebilir. Bu, LLM işlemeye ihtiyaç duymayan aç/kapa komutları, durum kontrolleri veya hızlı eylemler için kullanışlıdır.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

46. Komut işleyici bağlamı:

- `senderId`: Gönderenin kimliği (varsa)
- `channel`: Komutun gönderildiği kanal
- `isAuthorizedSender`: Gönderenin yetkili bir kullanıcı olup olmadığı
- `args`: Komuttan sonra iletilen argümanlar (eğer `acceptsArgs: true`)
- `commandBody`: Komutun tam metni
- `config`: Geçerli OpenClaw yapılandırması

Komut seçenekleri:

- `name`: Komut adı (başındaki `/` olmadan)
- `description`: Komut listelerinde gösterilen yardım metni
- `acceptsArgs`: Komutun argüman kabul edip etmediği (varsayılan: false). False ise ve argüman verilirse, komut eşleşmez ve mesaj diğer işleyicilere düşer
- `requireAuth`: Yetkili gönderici gerektirip gerektirmediği (varsayılan: true)
- `handler`: `{ text: string }` döndüren fonksiyon (async olabilir)

Yetkilendirme ve argümanlarla örnek:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Notlar:

- Eklenti komutları, yerleşik komutlar ve AI ajanından **önce** işlenir
- Komutlar küresel olarak kaydedilir ve tüm kanallarda çalışır
- Komut adları büyük/küçük harfe duyarsızdır (`/MyStatus`, `/mystatus` ile eşleşir)
- Komut adları bir harfle başlamalı ve yalnızca harfler, sayılar, tireler ve alt çizgiler içermelidir
- Ayrılmış komut adları (ör. `help`, `status`, `reset` vb.) eklentiler tarafından geçersiz kılınamaz
- Eklentiler arasında yinelenen komut kaydı, tanılayıcı bir hatayla başarısız olur

### Arka plan servisleri kaydetme

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## 47. Adlandırma kuralları

- Gateway yöntemleri: `pluginId.action` (örnek: `voicecall.status`)
- Araçlar: `snake_case` (örnek: `voice_call`)
- CLI komutları: kebab veya camel; ancak çekirdek komutlarla çakışmaktan kaçının

## Skills

Eklentiler, depoda bir skill gönderebilir (`skills/<name>/SKILL.md`).
`plugins.entries.<id>.enabled` (veya diğer yapılandırma kapıları) ile etkinleştirin ve
çalışma alanınızda/yönetilen skill konumlarında mevcut olduğundan emin olun.

## Dağıtım (npm)

Önerilen paketleme:

- Ana paket: `openclaw` (bu depo)
- Eklentiler: `@openclaw/*` altında ayrı npm paketleri (örnek: `@openclaw/voice-call`)

Yayınlama sözleşmesi:

- Eklenti `package.json`’ü, bir veya daha fazla giriş dosyası içeren `openclaw.extensions`’ü içermelidir.
- Giriş dosyaları `.js` veya `.ts` olabilir (jiti, TS’yi çalışma zamanında yükler).
- `openclaw plugins install <npm-spec>`, `npm pack` kullanır, `~/.openclaw/extensions/<id>/` içine çıkarır ve yapılandırmada etkinleştirir.
- Yapılandırma anahtarı kararlılığı: kapsamlı paketler, `plugins.entries.*` için **kapsamsız** id’ye normalize edilir.

## Örnek eklenti: Voice Call

Bu depo bir sesli arama eklentisi içerir (Twilio veya günlükleme yedeği):

- Kaynak: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Araç: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Yapılandırma (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (isteğe bağlı `statusCallbackUrl`, `twimlUrl`)
- Yapılandırma (geliştirme): `provider: "log"` (ağ yok)

Kurulum ve kullanım için [Voice Call](/plugins/voice-call) ve `extensions/voice-call/README.md`’ye bakın.

## Güvenli kullanım notları

Eklentiler Gateway ile aynı işlem içinde çalışır. Bunları güvenilir kod olarak değerlendirin:

- Yalnızca güvendiğiniz eklentileri kurun.
- `plugins.allow` izin listelerini tercih edin.
- Değişikliklerden sonra Gateway’i yeniden başlatın.

## Eklentileri test etme

Eklentiler testlerle birlikte gönderilebilir (ve gönderilmelidir):

- Depo içi eklentiler, Vitest testlerini `src/**` altında tutabilir (örnek: `src/plugins/voice-call.plugin.test.ts`).
- Ayrı yayımlanan eklentiler kendi CI’larını (lint/build/test) çalıştırmalı ve `openclaw.extensions`’nın derlenmiş giriş noktasını işaret ettiğini doğrulamalıdır (`dist/index.js`).
