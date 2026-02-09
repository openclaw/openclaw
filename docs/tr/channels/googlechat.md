---
summary: "Google Chat uygulaması destek durumu, yetenekler ve yapılandırma"
read_when:
  - Google Chat kanal özellikleri üzerinde çalışırken
title: "Google Chat"
---

# Google Chat (Chat API)

Durum: Google Chat API webhook’ları (yalnızca HTTP) üzerinden DM’ler ve alanlar için hazır.

## Hızlı kurulum (başlangıç seviyesi)

1. Bir Google Cloud projesi oluşturun ve **Google Chat API**’yi etkinleştirin.
   - Şuraya gidin: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - API zaten etkin değilse etkinleştirin.
2. Bir **Service Account** oluşturun:
   - **Create Credentials** > **Service Account**’a tıklayın.
   - İstediğiniz gibi adlandırın (örn. `openclaw-chat`).
   - İzinleri boş bırakın (**Continue**’a basın).
   - Erişimi olan ilkeleri boş bırakın (**Done**’a basın).
3. **JSON Key** oluşturun ve indirin:
   - Service account listesinden az önce oluşturduğunuz hesabı tıklayın.
   - **Keys** sekmesine gidin.
   - **Add Key** > **Create new key**’e tıklayın.
   - **JSON**’u seçin ve **Create**’e basın.
4. İndirilen JSON dosyasını gateway ana makinenizde saklayın (örn. `~/.openclaw/googlechat-service-account.json`).
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) üzerinden bir Google Chat uygulaması oluşturun:
   - **Application info** bölümünü doldurun:
     - **App name**: (örn. `OpenClaw`)
     - **Avatar URL**: (örn. `https://openclaw.ai/logo.png`)
     - **Description**: (örn. `Personal AI Assistant`)
   - **Interactive features**’ı etkinleştirin.
   - **Functionality** altında **Join spaces and group conversations**’ı işaretleyin.
   - **Connection settings** altında **HTTP endpoint URL**’yi seçin.
   - **Triggers** altında **Use a common HTTP endpoint URL for all triggers**’ı seçin ve gateway’nizin herkese açık URL’sinin sonuna `/googlechat` ekleyin.
     - _İpucu: Gateway’nizin herkese açık URL’sini bulmak için `openclaw status` çalıştırın._
   - **Visibility** altında **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**’ı işaretleyin.
   - Metin kutusuna e-posta adresinizi girin (örn. `user@example.com`).
   - Altta **Save**’e tıklayın.
6. **Uygulama durumunu etkinleştirin**:
   - Kaydettikten sonra **sayfayı yenileyin**.
   - **App status** bölümünü bulun (genellikle kaydettikten sonra üstte veya altta).
   - Durumu **Live - available to users** olarak değiştirin.
   - **Save**’e tekrar tıklayın.
7. OpenClaw’ı service account yolu + webhook audience ile yapılandırın:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Veya yapılandırma: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Webhook audience türünü + değerini ayarlayın (Chat uygulaması yapılandırmanızla eşleşmelidir).
9. Gateway’i başlatın. Google Chat, webhook yolunuza POST isteği gönderecektir.

## Google Chat’e ekleme

Gateway çalışır durumdayken ve e-postanız görünürlük listesine eklendikten sonra:

1. [Google Chat](https://chat.google.com/)’e gidin.
2. **Direct Messages** yanındaki **+** (artı) simgesine tıklayın.
3. Arama çubuğuna (normalde kişi eklediğiniz yer) Google Cloud Console’da yapılandırdığınız **App name**’i yazın.
   - **Not**: Bot, özel bir uygulama olduğu için “Marketplace” göz atma listesinde _görünmez_. Ada göre aratmanız gerekir.
4. Sonuçlardan botunuzu seçin.
5. 1:1 konuşma başlatmak için **Add** veya **Chat**’e tıklayın.
6. Asistanı tetiklemek için “Hello” gönderin!

## Herkese açık URL (yalnızca Webhook)

Google Chat webhook’ları herkese açık bir HTTPS uç noktası gerektirir. Güvenlik için **yalnızca `/googlechat` yolunu** internete açın. OpenClaw panosunu ve diğer hassas uç noktaları özel ağınızda tutun.

### Seçenek A: Tailscale Funnel (Önerilen)

Özel pano için Tailscale Serve, herkese açık webhook yolu için Funnel kullanın. Bu, `/`’yi özel tutarken yalnızca `/googlechat`’ü açar.

1. **Gateway’in hangi adrese bağlandığını kontrol edin:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP adresini not alın (örn. `127.0.0.1`, `0.0.0.0` veya `100.x.x.x` gibi Tailscale IP’niz).

2. **Panoyu yalnızca tailnet’e açın (8443 portu):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Yalnızca webhook yolunu herkese açık hale getirin:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Düğümü Funnel erişimi için yetkilendirin:**
   İstenirse, çıktıda gösterilen yetkilendirme URL’sini ziyaret ederek tailnet politikanızda bu düğüm için Funnel’ı etkinleştirin.

5. **Yapılandırmayı doğrulayın:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Herkese açık webhook URL’niz:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Özel pano tailnet ile sınırlı kalır:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat uygulaması yapılandırmasında herkese açık URL’yi (`:8443` olmadan) kullanın.

> Not: Bu yapılandırma yeniden başlatmalar arasında kalıcıdır. Daha sonra kaldırmak için `tailscale funnel reset` ve `tailscale serve reset` çalıştırın.

### Seçenek B: Reverse Proxy (Caddy)

Caddy gibi bir reverse proxy kullanıyorsanız, yalnızca belirli yolu proxy’leyin:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Bu yapılandırma ile `your-domain.com/`’ye gelen tüm istekler yok sayılır veya 404 olarak döndürülürken, `your-domain.com/googlechat` güvenli şekilde OpenClaw’a yönlendirilir.

### Seçenek C: Cloudflare Tunnel

Tünelinizin ingress kurallarını yalnızca webhook yolunu yönlendirecek şekilde yapılandırın:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Nasıl çalışır

1. Google Chat, gateway’e webhook POST’ları gönderir. Her istek bir `Authorization: Bearer <token>` başlığı içerir.
2. OpenClaw, belirteci yapılandırılmış `audienceType` + `audience` ile doğrular:
   - `audienceType: "app-url"` → audience, HTTPS webhook URL’nizdir.
   - `audienceType: "project-number"` → audience, Cloud proje numarasıdır.
3. Mesajlar alana göre yönlendirilir:
   - DM’ler `agent:<agentId>:googlechat:dm:<spaceId>` oturum anahtarını kullanır.
   - Alanlar `agent:<agentId>:googlechat:group:<spaceId>` oturum anahtarını kullanır.
4. DM erişimi varsayılan olarak eşleştirme gerektirir. Bilinmeyen gönderenler bir eşleştirme kodu alır; şu komutla onaylayın:
   - `openclaw pairing approve googlechat <code>`
5. Grup alanları varsayılan olarak @-mention gerektirir. Mention algılaması uygulamanın kullanıcı adına ihtiyaç duyuyorsa `botUser` kullanın.

## Hedefler

Teslimat ve izin listeleri için bu tanımlayıcıları kullanın:

- Doğrudan mesajlar: `users/<userId>` veya `users/<email>` (e-posta adresleri kabul edilir).
- Alanlar: `spaces/<spaceId>`.

## Yapılandırma öne çıkanlar

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notlar:

- Service account kimlik bilgileri `serviceAccount` (JSON dizesi) ile satır içi olarak da geçirilebilir.
- Varsayılan webhook yolu, `webhookPath` ayarlanmadıysa `/googlechat`’dur.
- Tepkiler, `actions.reactions` etkinleştirildiğinde `reactions` aracı ve `channels action` üzerinden kullanılabilir.
- `typingIndicator`, `none`, `message` (varsayılan) ve `reaction`’yi destekler (tepki için kullanıcı OAuth gerekir).
- Ekler Chat API üzerinden indirilir ve medya hattında saklanır (boyut `mediaMaxMb` ile sınırlandırılır).

## Sorun Giderme

### 405 Method Not Allowed

Google Cloud Logs Explorer’da aşağıdakine benzer hatalar görüyorsanız:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Bu, webhook işleyicisinin kayıtlı olmadığı anlamına gelir. Yaygın nedenler:

1. **Kanal yapılandırılmamış**: Yapılandırmanızda `channels.googlechat` bölümü eksik. Şu komutla doğrulayın:

   ```bash
   openclaw config get channels.googlechat
   ```

   “Config path not found” dönerse yapılandırmayı ekleyin ([Yapılandırma öne çıkanlar](#yapılandırma-öne-çıkanlar)’a bakın).

2. **Eklenti etkin değil**: Eklenti durumunu kontrol edin:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   “disabled” gösteriyorsa yapılandırmanıza `plugins.entries.googlechat.enabled: true` ekleyin.

3. **Gateway yeniden başlatılmamış**: Yapılandırma ekledikten sonra gateway’i yeniden başlatın:

   ```bash
   openclaw gateway restart
   ```

Kanalın çalıştığını doğrulayın:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Diğer sorunlar

- Kimlik doğrulama hataları veya eksik audience yapılandırması için `openclaw channels status --probe`’i kontrol edin.
- Hiç mesaj gelmiyorsa Chat uygulamasının webhook URL’sini + olay aboneliklerini doğrulayın.
- Mention kısıtlaması yanıtları engelliyorsa `botUser`’yi uygulamanın kullanıcı kaynak adına ayarlayın ve `requireMention`’ü doğrulayın.
- İsteklerin gateway’e ulaşıp ulaşmadığını görmek için test mesajı gönderirken `openclaw logs --follow` kullanın.

İlgili belgeler:

- [Gateway yapılandırması](/gateway/configuration)
- [Güvenlik](/gateway/security)
- [Tepkiler](/tools/reactions)
