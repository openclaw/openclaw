---
summary: "Microsoft Teams bot destek durumu, yetenekler ve yapılandırma"
read_when:
  - MS Teams kanal özellikleri üzerinde çalışırken
title: "Microsoft Teams"
---

# Microsoft Teams (eklenti)

> "Abandon all hope, ye who enter here."

Güncellendi: 2026-01-21

Durum: metin + DM ekleri desteklenir; kanal/grup dosya gönderimi `sharePointSiteId` + Graph izinleri gerektirir (bkz. [Grup sohbetlerinde dosya gönderme](#grup-sohbetlerinde-dosya-gönderme)). Anketler Adaptive Cards üzerinden gönderilir.

## Gerekli eklenti

Microsoft Teams bir eklenti olarak gelir ve çekirdek kurulumla birlikte gelmez.

**Kırıcı değişiklik (2026.1.15):** MS Teams çekirdekten çıkarıldı. Kullanıyorsanız eklentiyi yüklemeniz gerekir.

Açıklama: çekirdek kurulumları daha hafif tutar ve MS Teams bağımlılıklarının bağımsız güncellenmesini sağlar.

CLI ile kurulum (npm kayıt defteri):

```bash
openclaw plugins install @openclaw/msteams
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/msteams
```

Yapılandırma/ilk kurulum sırasında Teams’i seçerseniz ve bir git checkout tespit edilirse,
OpenClaw yerel kurulum yolunu otomatik olarak sunar.

Ayrıntılar: [Eklentiler](/tools/plugin)

## Hızlı kurulum (başlangıç)

1. Microsoft Teams eklentisini yükleyin.
2. Bir **Azure Bot** oluşturun (App ID + istemci gizli anahtarı + tenant ID).
3. OpenClaw’ı bu kimlik bilgileriyle yapılandırın.
4. `/api/messages`’i (varsayılan port 3978) genel bir URL veya tünel üzerinden açığa çıkarın.
5. Teams uygulama paketini yükleyin ve gateway’i başlatın.

Minimal yapılandırma:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Not: grup sohbetleri varsayılan olarak engellidir (`channels.msteams.groupPolicy: "allowlist"`). Grup yanıtlarına izin vermek için `channels.msteams.groupAllowFrom`’ü ayarlayın (veya herhangi bir üyenin izinli olması için, mention gerektiren `groupPolicy: "open"`’ü kullanın).

## Hedefler

- Teams DM’leri, grup sohbetleri veya kanallar üzerinden OpenClaw ile konuşmak.
- Yönlendirmeyi deterministik tutmak: yanıtlar her zaman geldikleri kanala geri gider.
- Varsayılan olarak güvenli kanal davranışı (aksi yapılandırılmadıkça mention gereklidir).

## Yapılandırma yazımları

Varsayılan olarak Microsoft Teams, `/config set|unset` tarafından tetiklenen yapılandırma güncellemelerini yazmaya yetkilidir (`commands.config: true` gerektirir).

Şununla devre dışı bırakın:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Erişim denetimi (DM’ler + gruplar)

**DM erişimi**

- Varsayılan: `channels.msteams.dmPolicy = "pairing"`. Bilinmeyen gönderenler onaylanana kadar yok sayılır.
- `channels.msteams.allowFrom` AAD nesne kimliklerini, UPN’leri veya görünen adları kabul eder. Sihirbaz, kimlik bilgileri izin verdiğinde adları Microsoft Graph üzerinden kimliklere çözer.

**Grup erişimi**

- Varsayılan: `channels.msteams.groupPolicy = "allowlist"` (`groupAllowFrom` eklemediğiniz sürece engelli). Ayarlanmadığında varsayılanı geçersiz kılmak için `channels.defaults.groupPolicy`’i kullanın.
- `channels.msteams.groupAllowFrom`, grup sohbetlerinde/kanallarda hangi gönderenlerin tetikleyebileceğini kontrol eder (`channels.msteams.allowFrom`’e geri düşer).
- Herhangi bir üyeye izin vermek için `groupPolicy: "open"`’ü ayarlayın (varsayılan olarak hâlâ mention gerektirir).
- **Hiç kanal** istemiyorsanız `channels.msteams.groupPolicy: "disabled"`’i ayarlayın.

Örnek:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + kanal izin listesi**

- `channels.msteams.teams` altında ekipleri ve kanalları listeleyerek grup/kanal yanıtlarının kapsamını belirleyin.
- Anahtarlar ekip kimlikleri veya adları olabilir; kanal anahtarları konuşma kimlikleri veya adları olabilir.
- `groupPolicy="allowlist"` ayarlıysa ve bir ekip izin listesi mevcutsa, yalnızca listelenen ekipler/kanallar kabul edilir (mention gerektirir).
- Yapılandırma sihirbazı `Team/Channel` girdilerini kabul eder ve sizin için saklar.
- Başlangıçta OpenClaw, Graph izinleri izin verdiğinde ekip/kanal ve kullanıcı izin listesi adlarını kimliklere çözer
  ve eşlemeyi günlüğe yazar; çözülemeyen girdiler yazıldığı gibi korunur.

Örnek:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Nasıl çalışır

1. Microsoft Teams eklentisini yükleyin.
2. Bir **Azure Bot** oluşturun (App ID + gizli anahtar + tenant ID).
3. Botu referanslayan ve aşağıdaki RSC izinlerini içeren bir **Teams uygulama paketi** oluşturun.
4. Teams uygulamasını bir ekibe yükleyin (veya DM’ler için kişisel kapsam).
5. `~/.openclaw/openclaw.json` içinde (veya ortam değişkenleriyle) `msteams`’u yapılandırın ve gateway’i başlatın.
6. Gateway varsayılan olarak `/api/messages` üzerinde Bot Framework webhook trafiğini dinler.

## Azure Bot Kurulumu (Ön Koşullar)

OpenClaw’ı yapılandırmadan önce bir Azure Bot kaynağı oluşturmanız gerekir.

### Adım 1: Azure Bot oluşturun

1. [Azure Bot Oluştur](https://portal.azure.com/#create/Microsoft.AzureBot) sayfasına gidin
2. **Basics** sekmesini doldurun:

   | Field              | Değer                                                                                     |
   | ------------------ | ----------------------------------------------------------------------------------------- |
   | **Bot handle**     | Bot adınız, örn. `openclaw-msteams` (benzersiz olmalı) |
   | **Subscription**   | Azure aboneliğinizi seçin                                                                 |
   | **Resource group** | Yeni oluşturun veya mevcut olanı kullanın                                                 |
   | **Pricing tier**   | Geliştirme/test için **Free**                                                             |
   | **Type of App**    | **Single Tenant** (önerilir - aşağıdaki nota bakın)                    |
   | **Creation type**  | **Create new Microsoft App ID**                                                           |

> **Kullanımdan kaldırma bildirimi:** Yeni çok kiracılı botların oluşturulması 2025-07-31’den sonra kullanımdan kaldırıldı. Yeni botlar için **Single Tenant** kullanın.

3. **Review + create** → **Create**’e tıklayın (~1-2 dakika bekleyin)

### Adım 2: Kimlik bilgilerini alın

1. Azure Bot kaynağınıza gidin → **Configuration**
2. **Microsoft App ID**’yi kopyalayın → bu sizin `appId`’ünüzdür
3. **Manage Password**’a tıklayın → App Registration’a gidin
4. **Certificates & secrets** → **New client secret** → **Value**’yu kopyalayın → bu sizin `appPassword`’ünüzdür
5. **Overview** → **Directory (tenant) ID**’yi kopyalayın → bu sizin `tenantId`’inizdir

### Adım 3: Mesajlaşma uç noktasını yapılandırın

1. Azure Bot → **Configuration**
2. **Messaging endpoint**’i webhook URL’nize ayarlayın:
   - Üretim: `https://your-domain.com/api/messages`
   - Yerel geliştirme: bir tünel kullanın (aşağıda [Yerel Geliştirme](#yerel-geliştirme-tünelleme) bölümüne bakın)

### Adım 4: Teams kanalını etkinleştirin

1. Azure Bot → **Channels**
2. **Microsoft Teams** → Configure → Save
3. Hizmet Şartlarını kabul edin

## Yerel Geliştirme (Tünelleme)

Teams `localhost`’e erişemez. Yerel geliştirme için bir tünel kullanın:

**Seçenek A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Seçenek B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Geliştirici Portalı (Alternatif)

Manifest ZIP’i manuel oluşturmak yerine [Teams Geliştirici Portalı](https://dev.teams.microsoft.com/apps)’nı kullanabilirsiniz:

1. **+ New app**’e tıklayın
2. Temel bilgileri doldurun (ad, açıklama, geliştirici bilgileri)
3. **App features** → **Bot**
4. **Enter a bot ID manually**’yi seçin ve Azure Bot App ID’nizi yapıştırın
5. Kapsamları işaretleyin: **Personal**, **Team**, **Group Chat**
6. **Distribute** → **Download app package**
7. Teams’te: **Apps** → **Manage your apps** → **Upload a custom app** → ZIP’i seçin

Bu yöntem genellikle JSON manifestlerini elle düzenlemekten daha kolaydır.

## Botu test etme

**Seçenek A: Azure Web Chat (önce webhook’u doğrulayın)**

1. Azure Portal → Azure Bot kaynağınız → **Test in Web Chat**
2. Bir mesaj gönderin — bir yanıt görmelisiniz
3. Bu, Teams kurulumundan önce webhook uç noktanızın çalıştığını doğrular

**Seçenek B: Teams (uygulama kurulumundan sonra)**

1. Teams uygulamasını yükleyin (yan yükleme veya kuruluş kataloğu)
2. Teams’te botu bulun ve bir DM gönderin
3. Gelen etkinlikler için gateway günlüklerini kontrol edin

## Kurulum (minimal, yalnızca metin)

1. **Microsoft Teams eklentisini yükleyin**
   - npm’den: `openclaw plugins install @openclaw/msteams`
   - Yerel checkout’tan: `openclaw plugins install ./extensions/msteams`

2. **Bot kaydı**
   - Bir Azure Bot oluşturun (yukarıya bakın) ve şunları not edin:
     - App ID
     - İstemci gizli anahtarı (App parolası)
     - Tenant ID (tek kiracılı)

3. **Teams uygulama manifesti**
   - `botId = <App ID>` ile bir `bot` girdisi ekleyin.
   - Kapsamlar: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (kişisel kapsam dosya işlemleri için gereklidir).
   - RSC izinlerini ekleyin (aşağıda).
   - Simgeleri oluşturun: `outline.png` (32x32) ve `color.png` (192x192).
   - Üç dosyayı birlikte zipleyin: `manifest.json`, `outline.png`, `color.png`.

4. **OpenClaw’ı yapılandırın**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Yapılandırma anahtarları yerine ortam değişkenlerini de kullanabilirsiniz:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot uç noktası**
   - Azure Bot Messaging Endpoint’i şuna ayarlayın:
     - `https://<host>:3978/api/messages` (veya seçtiğiniz yol/port).

6. **Gateway’i çalıştırın**
   - Eklenti yüklendiğinde ve kimlik bilgileriyle `msteams` yapılandırması mevcut olduğunda Teams kanalı otomatik olarak başlar.

## History context

- `channels.msteams.historyLimit`, son kanal/grup mesajlarından kaç tanesinin isteme sarılacağını kontrol eder.
- `messages.groupChat.historyLimit`’ye geri düşer. Devre dışı bırakmak için `0`’i ayarlayın (varsayılan 50).
- DM geçmişi `channels.msteams.dmHistoryLimit` ile sınırlandırılabilir (kullanıcı dönüşleri). Kullanıcı başına geçersiz kılmalar: `channels.msteams.dms["<user_id>"].historyLimit`.

## Güncel Teams RSC İzinleri (Manifest)

Bunlar Teams uygulama manifestimizdeki **mevcut resourceSpecific izinlerdir**. Yalnızca uygulamanın kurulu olduğu ekip/sohbet içinde geçerlidir.

**Kanallar için (ekip kapsamı):**

- `ChannelMessage.Read.Group` (Application) - @mention olmadan tüm kanal mesajlarını alma
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Grup sohbetleri için:**

- `ChatMessage.Read.Chat` (Application) - @mention olmadan tüm grup sohbeti mesajlarını alma

## Örnek Teams Manifesti (redacted)

Gerekli alanları içeren minimal, geçerli bir örnek. Kimlikleri ve URL’leri değiştirin.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Manifest uyarıları (olmazsa olmaz alanlar)

- `bots[].botId` **Azure Bot App ID** ile eşleşmelidir.
- `webApplicationInfo.id` **Azure Bot App ID** ile eşleşmelidir.
- `bots[].scopes`, kullanmayı planladığınız yüzeyleri içermelidir (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true`, kişisel kapsamda dosya işlemleri için gereklidir.
- Kanal trafiği istiyorsanız `authorization.permissions.resourceSpecific` kanal okuma/gönderme içermelidir.

### Mevcut bir uygulamayı güncelleme

Zaten yüklü bir Teams uygulamasını güncellemek için (örn. RSC izinleri eklemek):

1. `manifest.json`’inizi yeni ayarlarla güncelleyin
2. **`version` alanını artırın** (örn. `1.0.0` → `1.1.0`)
3. Simgelerle birlikte manifesti **yeniden zipleyin** (`manifest.json`, `outline.png`, `color.png`)
4. Yeni zip’i yükleyin:
   - **Seçenek A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → uygulamanızı bulun → Upload new version
   - **Seçenek B (Yan yükleme):** Teams’te → Apps → Manage your apps → Upload a custom app
5. **Ekip kanalları için:** Yeni izinlerin geçerli olması için uygulamayı her ekipte yeniden yükleyin
6. **Teams’i tamamen kapatıp yeniden başlatın** (yalnızca pencereyi kapatmak yeterli değildir) — önbelleğe alınmış uygulama meta verilerini temizlemek için

## Yetenekler: Yalnızca RSC vs Graph

### **Yalnızca Teams RSC** ile (uygulama yüklü, Graph API izinleri yok)

Çalışır:

- Kanal mesajı **metin** içeriğini okuma.
- Kanal mesajı **metin** içeriğini gönderme.
- **Kişisel (DM)** dosya eklerini alma.

Çalışmaz:

- Kanal/grup **görüntü veya dosya içerikleri** (yük yalnızca HTML taslağı içerir).
- SharePoint/OneDrive’da saklanan ekleri indirme.
- Mesaj geçmişini okuma (canlı webhook olayı dışında).

### **Teams RSC + Microsoft Graph Application izinleri** ile

Ekler:

- Barındırılan içerikleri indirme (mesajlara yapıştırılan görüntüler).
- SharePoint/OneDrive’da saklanan dosya eklerini indirme.
- Graph üzerinden kanal/sohbet mesaj geçmişini okuma.

### RSC vs Graph API

| Yetenek                     | RSC İzinleri                                | Graph API                                          |
| --------------------------- | ------------------------------------------- | -------------------------------------------------- |
| **Gerçek zamanlı mesajlar** | Evet (webhook ile)       | Hayır (yalnızca anketleme)      |
| **Geçmiş mesajlar**         | Hayır                                       | Evet (geçmiş sorgulanabilir)    |
| **Kurulum karmaşıklığı**    | Yalnızca uygulama manifesti                 | Yönetici onayı + belirteç akışı gerekir            |
| **Çevrimdışı çalışır**      | Hayır (çalışıyor olmalı) | Evet (her zaman sorgulanabilir) |

**Özet:** RSC gerçek zamanlı dinleme içindir; Graph API geçmiş erişim içindir. Çevrimdışıyken kaçırılan mesajları yakalamak için `ChannelMessage.Read.All` ile Graph API gerekir (yönetici onayı gerektirir).

## Graph özellikli medya + geçmiş (kanallar için gereklidir)

**Kanallarda** görüntü/dosya istiyorsanız veya **mesaj geçmişini** almak istiyorsanız, Microsoft Graph izinlerini etkinleştirip yönetici onayı vermelisiniz.

1. Entra ID (Azure AD) **App Registration**’da Microsoft Graph **Application izinlerini** ekleyin:
   - `ChannelMessage.Read.All` (kanal ekleri + geçmiş)
   - `Chat.Read.All` veya `ChatMessage.Read.All` (grup sohbetleri)
2. **Grant admin consent** for the tenant.
3. Teams uygulaması **manifest sürümünü** artırın, yeniden yükleyin ve **Teams’te uygulamayı yeniden kurun**.
4. Önbelleğe alınmış uygulama meta verilerini temizlemek için **Teams’i tamamen kapatıp yeniden başlatın**.

## Bilinen Sınırlamalar

### Webhook zaman aşımları

Teams mesajları HTTP webhook üzerinden iletir. İşleme çok uzun sürerse (örn. yavaş LLM yanıtları), şunları görebilirsiniz:

- Gateway zaman aşımları
- Teams’in mesajı yeniden denemesi (yinelenmelere yol açar)
- Düşen yanıtlar

OpenClaw bunu hızlıca yanıt döndürüp yanıtları proaktif olarak göndererek ele alır; ancak çok yavaş yanıtlar yine de sorun çıkarabilir.

### Biçimlendirme

Teams markdown’ı Slack veya Discord’a göre daha sınırlıdır:

- Temel biçimlendirme çalışır: **kalın**, _italik_, `code`, bağlantılar
- Karmaşık markdown (tablolar, iç içe listeler) doğru render edilmeyebilir
- Anketler ve keyfi kart gönderimleri için Adaptive Cards desteklenir (aşağıya bakın)

## Yapılandırma

Temel ayarlar (paylaşılan kanal kalıpları için bkz. `/gateway/configuration`):

- `channels.msteams.enabled`: kanalı etkinleştir/devre dışı bırak.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot kimlik bilgileri.
- `channels.msteams.webhook.port` (varsayılan `3978`)
- `channels.msteams.webhook.path` (varsayılan `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (varsayılan: eşleştirme)
- `channels.msteams.allowFrom`: DM’ler için izin listesi (AAD nesne kimlikleri, UPN’ler veya görünen adlar). Sihirbaz, Graph erişimi mevcutken kurulum sırasında adları kimliklere çözer.
- `channels.msteams.textChunkLimit`: giden metin parça boyutu.
- `channels.msteams.chunkMode`: uzunluk parçalamadan önce boş satırlara (paragraf sınırları) göre bölmek için `length` (varsayılan) veya `newline`.
- `channels.msteams.mediaAllowHosts`: gelen ek ana bilgisayarları için izin listesi (varsayılan Microsoft/Teams alanları).
- `channels.msteams.mediaAuthAllowHosts`: medya yeniden denemelerinde Authorization başlıklarını eklemek için izin listesi (varsayılan Graph + Bot Framework ana bilgisayarları).
- `channels.msteams.requireMention`: kanallar/gruplarda @mention gerektir (varsayılan true).
- `channels.msteams.replyStyle`: `thread | top-level` (bkz. [Yanıt Stili](#yanıt-stili-threadler-vs-gönderiler)).
- `channels.msteams.teams.<teamId>.replyStyle`: ekip başına geçersiz kılma.
- `channels.msteams.teams.<teamId>.requireMention`: ekip başına geçersiz kılma.
- `channels.msteams.teams.<teamId>.tools`: kanal geçersiz kılma eksik olduğunda kullanılan ekip başına varsayılan araç politika geçersiz kılmaları (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.toolsBySender`: ekip başına gönderen başına varsayılan araç politika geçersiz kılmaları (`"*"` joker karakteri desteklenir).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: kanal başına geçersiz kılma.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: kanal başına geçersiz kılma.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: kanal başına araç politika geçersiz kılmaları (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: kanal başına gönderen başına araç politika geçersiz kılmaları (`"*"` joker karakteri desteklenir).
- `channels.msteams.sharePointSiteId`: grup sohbetleri/kanallarda dosya yüklemeleri için SharePoint site kimliği (bkz. [Grup sohbetlerinde dosya gönderme](#grup-sohbetlerinde-dosya-gönderme)).

## Routing & Sessions

- Oturum anahtarları standart ajan biçimini izler (bkz. [/concepts/session](/concepts/session)):
  - Doğrudan mesajlar ana oturumu paylaşır (`agent:<agentId>:<mainKey>`).
  - Kanal/grup mesajları konuşma kimliğini kullanır:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Yanıt Stili: Thread’ler vs Gönderiler

Teams yakın zamanda aynı temel veri modeli üzerinde iki kanal UI stili tanıttı:

| Stil                                              | Açıklama                                                         | Önerilen `replyStyle`                    |
| ------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| **Gönderiler** (klasik)        | Mesajlar, altında thread’li yanıtlar olan kartlar olarak görünür | `thread` (varsayılan) |
| **Thread’ler** (Slack benzeri) | Mesajlar Slack’e daha benzer şekilde doğrusal akar               | `top-level`                              |

**Sorun:** Teams API, bir kanalın hangi UI stilini kullandığını açığa çıkarmaz. Yanlış `replyStyle` kullanırsanız:

- Thread tarzı bir kanalda `thread` → yanıtlar garip biçimde iç içe görünür
- Gönderiler tarzı bir kanalda `top-level` → yanıtlar thread yerine ayrı üst düzey gönderiler olarak görünür

**Çözüm:** Kanalın kurulumuna göre `replyStyle`’yı kanal bazında yapılandırın:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Ekler & Görseller

**Mevcut sınırlamalar:**

- **DM’ler:** Görseller ve dosya ekleri Teams bot dosya API’leri üzerinden çalışır.
- **Kanallar/gruplar:** Ekler M365 depolamasında (SharePoint/OneDrive) bulunur. Webhook yükü yalnızca bir HTML taslağı içerir, gerçek dosya baytlarını içermez. **Kanal eklerini indirmek için Graph API izinleri gereklidir**.

Graph izinleri olmadan, görsel içeren kanal mesajları yalnızca metin olarak alınır (görsel içeriği bot tarafından erişilebilir değildir).
Varsayılan olarak OpenClaw yalnızca Microsoft/Teams ana bilgisayar adlarından medyayı indirir. `channels.msteams.mediaAllowHosts` ile geçersiz kılın (herhangi bir ana bilgisayara izin vermek için `["*"]`’i kullanın).
Authorization başlıkları yalnızca `channels.msteams.mediaAuthAllowHosts` içindeki ana bilgisayarlar için eklenir (varsayılan Graph + Bot Framework ana bilgisayarları). Bu listeyi sıkı tutun (çok kiracılı soneklerden kaçının).

## Grup sohbetlerinde dosya gönderme

Botlar, yerleşik FileConsentCard akışıyla DM’lerde dosya gönderebilir. Ancak **grup sohbetlerinde/kanallarda dosya gönderme** ek kurulum gerektirir:

| Context                                     | Dosyaların gönderilme şekli                         | Gerekli kurulum                                |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| **DM’ler**                                  | FileConsentCard → kullanıcı kabul eder → bot yükler | Kutudan çıktığı gibi çalışır                   |
| **Grup sohbetleri/kanallar**                | SharePoint’e yükle → bağlantı paylaş                | `sharePointSiteId` + Graph izinleri gerektirir |
| **Images (any context)** | Base64 kodlu satır içi                              | Kutudan çıktığı gibi çalışır                   |

### Neden grup sohbetleri SharePoint gerektirir

Botların kişisel bir OneDrive sürücüsü yoktur (`/me/drive` Graph API uç noktası uygulama kimlikleri için çalışmaz). Grup sohbetlerinde/kanallarda dosya göndermek için bot, bir **SharePoint sitesine** yükler ve bir paylaşım bağlantısı oluşturur.

### Kurulum

1. Entra ID (Azure AD) → App Registration’da **Graph API izinlerini** ekleyin:
   - `Sites.ReadWrite.All` (Application) - SharePoint’e dosya yükleme
   - `Chat.Read.All` (Application) - isteğe bağlı, kullanıcı başına paylaşım bağlantılarını etkinleştirir

2. **Grant admin consent** for the tenant.

3. **SharePoint site kimliğinizi alın:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw’ı yapılandırın:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Paylaşım davranışı

| Permission                              | Paylaşım davranışı                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Yalnızca `Sites.ReadWrite.All`          | Kurum genelinde paylaşım bağlantısı (kurumdaki herkes erişebilir)         |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Kullanıcı başına paylaşım bağlantısı (yalnızca sohbet üyeleri erişebilir) |

Kullanıcı başına paylaşım daha güvenlidir; yalnızca sohbet katılımcıları dosyaya erişebilir. `Chat.Read.All` izni eksikse, bot kurum genelinde paylaşıma geri düşer.

### Geri dönüş davranışı

| Scenario                                                  | Sonuç                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Grup sohbeti + dosya + `sharePointSiteId` yapılandırılmış | SharePoint’e yükle, paylaşım bağlantısı gönder                                           |
| Grup sohbeti + dosya + `sharePointSiteId` yok             | OneDrive yüklemesini dene (başarısız olabilir), yalnızca metin gönder |
| Kişisel sohbet + dosya                                    | FileConsentCard akışı (SharePoint olmadan çalışır)                    |
| Herhangi bir bağlam + görsel                              | Base64 kodlu satır içi (SharePoint olmadan çalışır)                   |

### Dosyaların saklandığı konum

Yüklenen dosyalar, yapılandırılmış SharePoint sitesinin varsayılan belge kitaplığındaki `/OpenClawShared/` klasöründe saklanır.

## Anketler (Adaptive Cards)

OpenClaw, Teams anketlerini Adaptive Cards olarak gönderir (yerel bir Teams anket API’si yoktur).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Oylar gateway tarafından `~/.openclaw/msteams-polls.json`’ye kaydedilir.
- Oyları kaydetmek için gateway’in çevrimiçi kalması gerekir.
- Anketler henüz sonuç özetlerini otomatik olarak paylaşmaz (gerekirse depo dosyasını inceleyin).

## Adaptive Cards (keyfi)

`message` aracı veya CLI kullanarak Teams kullanıcılarına veya konuşmalarına herhangi bir Adaptive Card JSON’u gönderin.

`card` parametresi bir Adaptive Card JSON nesnesini kabul eder. `card` sağlandığında mesaj metni isteğe bağlıdır.

**Ajan aracı:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Kart şeması ve örnekler için [Adaptive Cards belgelerine](https://adaptivecards.io/) bakın. Hedef biçim ayrıntıları için aşağıdaki [Hedef biçimleri](#hedef-biçimleri) bölümüne bakın.

## Hedef biçimleri

MSTeams hedefleri, kullanıcılar ve konuşmalar arasında ayrım yapmak için önekler kullanır:

| Hedef türü                            | Biçim                            | Örnek                                                                 |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| Kullanıcı (ID ile) | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                           |
| Kullanıcı (ad ile) | `user:<display-name>`            | `user:John Smith` (Graph API gerektirir)           |
| Grup/kanal                            | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                              |
| Grup/kanal (ham)   | `<conversation-id>`              | `19:abc123...@thread.tacv2` (`@thread` içeriyorsa) |

**CLI örnekleri:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Ajan aracı örnekleri:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Not: `user:` öneki olmadan adlar varsayılan olarak grup/ekip çözümlemesine gider. Kişileri görünen adla hedeflerken her zaman `user:` kullanın.

## Proaktif mesajlaşma

- Proaktif mesajlar, bir kullanıcı etkileşim kurduktan **sonra** mümkündür; çünkü bu noktada konuşma referanslarını saklarız.
- `/gateway/configuration`’deki `dmPolicy` ve izin listesi kısıtlamalarına bakın.

## Ekip ve Kanal Kimlikleri (Yaygın Tuzak)

Teams URL’lerindeki `groupId` sorgu parametresi, yapılandırmada kullanılan ekip kimliği **DEĞİLDİR**. Kimlikleri URL yolundan çıkarın:

**Ekip URL’si:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**Kanal URL’si:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Yapılandırma için:**

- Ekip Kimliği = `/team/`’dan sonraki yol parçası (URL-decode edilmiş, örn. `19:Bk4j...@thread.tacv2`)
- Kanal Kimliği = `/channel/`’den sonraki yol parçası (URL-decode edilmiş)
- `groupId` sorgu parametresini **yok sayın**

## Özel Kanallar

Botların özel kanallarda desteği sınırlıdır:

| Özellik                                              | Standart Kanallar | Özel Kanallar                       |
| ---------------------------------------------------- | ----------------- | ----------------------------------- |
| Bot kurulumu                                         | Evet              | Sınırlı                             |
| Gerçek zamanlı mesajlar (webhook) | Evet              | Çalışmayabilir                      |
| RSC izinleri                                         | Evet              | Farklı davranabilir                 |
| @mention’lar                            | Evet              | Bot erişilebilirse                  |
| Graph API geçmişi                                    | Evet              | Evet (izinlerle) |

**Özel kanallar çalışmıyorsa geçici çözümler:**

1. Bot etkileşimleri için standart kanalları kullanın
2. DM’leri kullanın — kullanıcılar her zaman botla doğrudan mesajlaşabilir
3. Geçmiş erişimi için Graph API kullanın (`ChannelMessage.Read.All` gerektirir)

## Sorun Giderme

### Yaygın sorunlar

- **Kanallarda görseller görünmüyor:** Graph izinleri veya yönetici onayı eksik. Teams uygulamasını yeniden kurun ve Teams’i tamamen kapatıp yeniden açın.
- **Kanalda yanıt yok:** Varsayılan olarak mention gereklidir; `channels.msteams.requireMention=false`’i ayarlayın veya ekip/kanal bazında yapılandırın.
- **Sürüm uyuşmazlığı (Teams hâlâ eski manifesti gösteriyor):** Uygulamayı kaldırıp yeniden ekleyin ve Teams’i tamamen kapatın.
- **Webhook’tan 401 Unauthorized:** Azure JWT olmadan manuel testte beklenir — uç noktanın erişilebilir olduğunu ancak kimlik doğrulamanın başarısız olduğunu gösterir. Doğru test için Azure Web Chat’i kullanın.

### Manifest yükleme hataları

- **"Icon file cannot be empty":** Manifest 0 bayt olan simge dosyalarına referans veriyor. Geçerli PNG simgeleri oluşturun ( `outline.png` için 32x32, `color.png` için 192x192).
- **"webApplicationInfo.Id already in use":** Uygulama başka bir ekip/sohbette hâlâ yüklü. Önce bulun ve kaldırın veya yayılım için 5-10 dakika bekleyin.
- **Yüklemede "Something went wrong":** Bunun yerine [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) üzerinden yükleyin, tarayıcı DevTools’u (F12) açın → Network sekmesi → gerçek hatayı görmek için yanıt gövdesini kontrol edin.
- **Yan yükleme başarısız:** "Upload a custom app" yerine "Upload an app to your org's app catalog" deneyin — bu genellikle yan yükleme kısıtlamalarını aşar.

### RSC izinleri çalışmıyor

1. `webApplicationInfo.id`’in botunuzun App ID’siyle birebir eşleştiğini doğrulayın
2. Uygulamayı yeniden yükleyin ve ekip/sohbette yeniden kurun
3. Kuruluş yöneticinizin RSC izinlerini engelleyip engellemediğini kontrol edin
4. Doğru kapsamı kullandığınızı doğrulayın: ekipler için `ChannelMessage.Read.Group`, grup sohbetleri için `ChatMessage.Read.Chat`

## Referanslar

- [Azure Bot Oluştur](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot kurulum kılavuzu
- [Teams Geliştirici Portalı](https://dev.teams.microsoft.com/apps) - Teams uygulamaları oluşturma/yönetme
- [Teams uygulama manifest şeması](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [RSC ile kanal mesajlarını alma](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC izinleri referansı](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot dosya işleme](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (kanal/grup için Graph gerekir)
- [Proaktif mesajlaşma](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
