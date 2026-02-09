---
summary: "Yalıtım veya iMessage gerektiğinde OpenClaw’ı sandbox içinde bir macOS VM’de (yerel veya barındırılan) çalıştırın"
read_when:
  - OpenClaw’ın ana macOS ortamınızdan yalıtılmış olmasını istiyorsanız
  - Sandbox içinde iMessage entegrasyonu (BlueBubbles) istiyorsanız
  - Klonlayabileceğiniz, sıfırlanabilir bir macOS ortamı istiyorsanız
  - Yerel ve barındırılan macOS VM seçeneklerini karşılaştırmak istiyorsanız
title: "macOS VM’leri"
---

# macOS VM’lerinde OpenClaw (Sandboxing)

## Önerilen varsayılan (çoğu kullanıcı)

- **Küçük bir Linux VPS**, her zaman açık bir Gateway ve düşük maliyet için. Bkz. [VPS hosting](/vps).
- **Özel donanım** (Mac mini veya Linux makine), tam denetim ve tarayıcı otomasyonu için **konut IP’si** istiyorsanız. Birçok site veri merkezi IP’lerini engeller; bu nedenle yerel tarama çoğu zaman daha iyi çalışır.
- **Hibrit:** Gateway’i ucuz bir VPS’te tutun ve tarayıcı/UI otomasyonuna ihtiyaç duyduğunuzda Mac’inizi **node** olarak bağlayın. [Nodes](/nodes) ve [Gateway remote](/gateway/remote).

macOS’a özgü yeteneklere (iMessage/BlueBubbles) özellikle ihtiyaç duyduğunuzda veya günlük Mac’inizden sıkı yalıtım istediğinizde macOS VM kullanın.

## macOS VM seçenekleri

### Apple Silicon Mac’inizde yerel VM (Lume)

Mevcut Apple Silicon Mac’inizde [Lume](https://cua.ai/docs/lume) kullanarak OpenClaw’ı sandbox içinde bir macOS VM’de çalıştırın.

Bu size şunları sağlar:

- Yalıtılmış tam macOS ortamı (ana sisteminiz temiz kalır)
- BlueBubbles üzerinden iMessage desteği (Linux/Windows’ta mümkün değil)
- VM’leri klonlayarak anında sıfırlama
- Ek donanım veya bulut maliyeti yok

### Barındırılan Mac sağlayıcıları (bulut)

Bulutta macOS istiyorsanız, barındırılan Mac sağlayıcıları da uygundur:

- [MacStadium](https://www.macstadium.com/) (barındırılan Mac’ler)
- Diğer barındırılan Mac satıcıları da çalışır; VM + SSH belgelerini izleyin

Bir macOS VM’ye SSH erişiminiz olduğunda, aşağıdaki 6. adımdan devam edin.

---

## Hızlı yol (Lume, deneyimli kullanıcılar)

1. Lume’u yükleyin
2. `lume create openclaw --os macos --ipsw latest`
3. Kurulum Asistanını tamamlayın, Remote Login’i (SSH) etkinleştirin
4. `lume run openclaw --no-display`
5. SSH ile bağlanın, OpenClaw’ı kurun, kanalları yapılandırın
6. Done

---

## İhtiyacınız olanlar (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- Ana makinede macOS Sequoia veya daha yeni
- VM başına ~60 GB boş disk alanı
- ~20 dakika

---

## 1. Lume’u yükleyin

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Eğer `~/.local/bin` PATH’inizde değilse:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Doğrulayın:

```bash
lume --version
```

Belgeler: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. macOS VM’yi oluşturun

```bash
lume create openclaw --os macos --ipsw latest
```

Bu işlem macOS’i indirir ve VM’yi oluşturur. Bir VNC penceresi otomatik olarak açılır.

Not: İndirme, bağlantınıza bağlı olarak biraz zaman alabilir.

---

## 3. Kurulum Asistanını tamamlayın

VNC penceresinde:

1. Dil ve bölgeyi seçin
2. Apple ID’yi atlayın (ya da daha sonra iMessage için istiyorsanız giriş yapın)
3. Bir kullanıcı hesabı oluşturun (kullanıcı adını ve parolayı hatırlayın)
4. Tüm isteğe bağlı özellikleri atlayın

Kurulum tamamlandıktan sonra SSH’yi etkinleştirin:

1. Sistem Ayarları → Genel → Paylaşım
2. “Remote Login”i etkinleştirin

---

## 4. VM’nin IP adresini alın

```bash
lume get openclaw
```

IP adresini bulun (genellikle `192.168.64.x`).

---

## 5. VM’ye SSH ile bağlanın

```bash
ssh youruser@192.168.64.X
```

`youruser` yerine oluşturduğunuz hesabı ve IP yerine VM’nizin IP’sini yazın.

---

## 6. OpenClaw’ı yükleyin

VM’nin içinde:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Model sağlayıcınızı (Anthropic, OpenAI, vb.) ayarlamak için yönlendirmeleri izleyin.

---

## 7. Kanalları yapılandırın

Yapılandırma dosyasını düzenleyin:

```bash
nano ~/.openclaw/openclaw.json
```

Kanallarınızı ekleyin:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Ardından WhatsApp’a giriş yapın (QR kodu tarayın):

```bash
openclaw channels login
```

---

## 8. VM’yi başlıksız çalıştırın

VM’yi durdurun ve ekransız olarak yeniden başlatın:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM arka planda çalışır. OpenClaw’ın daemon’u gateway’i çalışır durumda tutar.

Durumu kontrol etmek için:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: iMessage entegrasyonu

Bu, macOS’ta çalıştırmanın öldürücü özelliğidir. OpenClaw’a iMessage eklemek için [BlueBubbles](https://bluebubbles.app) kullanın.

VM’nin içinde:

1. bluebubbles.app’ten BlueBubbles’ı indirin
2. Apple ID’nizle giriş yapın
3. Web API’yi etkinleştirin ve bir parola belirleyin
4. BlueBubbles webhooks’larını gateway’inize yönlendirin (örnek: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

OpenClaw yapılandırmanıza ekleyin:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Gateway’i yeniden başlatın. Artık ajanınız iMessage gönderebilir ve alabilir.

Tam kurulum ayrıntıları: [BlueBubbles channel](/channels/bluebubbles)

---

## Altın imajı kaydedin

Daha fazla özelleştirmeden önce temiz durumunuzun anlık görüntüsünü alın:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

İstediğiniz zaman sıfırlayın:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 çalıştırma

VM’yi çalışır tutmak için:

- Mac’inizi prize takılı tutun
- Sistem Ayarları → Enerji Tasarrufu’nda uyku modunu devre dışı bırakın
- Gerekirse `caffeinate` kullanın

Gerçek anlamda her zaman açık kullanım için özel bir Mac mini veya küçük bir VPS düşünün. Bkz. [VPS hosting](/vps).

---

## Sorun Giderme

| Problem                      | Çözüm                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| VM’ye SSH ile bağlanılamıyor | VM’nin Sistem Ayarları’nda “Remote Login”in etkin olduğundan emin olun                                                |
| VM IP görünmüyor             | VM’nin tamamen açılmasını bekleyin, `lume get openclaw` komutunu tekrar çalıştırın                                    |
| Lume komutu bulunamadı       | `~/.local/bin` öğesini PATH’inize ekleyin                                                                             |
| WhatsApp QR taranmıyor       | `openclaw channels login` çalıştırılırken VM’ye (ana makineye değil) giriş yaptığınızdan emin olun |

---

## İlgili belgeler

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (ileri düzey)
- [Docker Sandboxing](/install/docker) (alternatif yalıtım yaklaşımı)
