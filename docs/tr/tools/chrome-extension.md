---
summary: "Chrome uzantısı: OpenClaw’ın mevcut Chrome sekmenizi yönetmesine izin verin"
read_when:
  - Ajanın mevcut bir Chrome sekmesini (araç çubuğu düğmesi) yönetmesini istiyorsunuz
  - Tailscale üzerinden uzak Gateway + yerel tarayıcı otomasyonuna ihtiyacınız var
  - Tarayıcı devralmanın güvenlik etkilerini anlamak istiyorsunuz
title: "Chrome Uzantısı"
---

# Chrome uzantısı (tarayıcı rölesi)

OpenClaw Chrome uzantısı, ayrı bir openclaw tarafından yönetilen Chrome profili başlatmak yerine ajanın **mevcut Chrome sekmelerinizi** (normal Chrome pencereniz) kontrol etmesini sağlar.

Bağlama/ayırma işlemi **tek bir Chrome araç çubuğu düğmesi** üzerinden yapılır.

## 19. Nedir (kavram)

Üç parça vardır:

- **Tarayıcı kontrol hizmeti** (Gateway veya node): ajanın/aracın (Gateway üzerinden) çağırdığı API
- **Yerel röle sunucusu** (loopback CDP): kontrol sunucusu ile uzantı arasında köprü kurar (varsayılan olarak `http://127.0.0.1:18792`)
- **Chrome MV3 uzantısı**: `chrome.debugger` kullanarak etkin sekmeye bağlanır ve CDP mesajlarını röleye iletir

Ardından OpenClaw, doğru profili seçerek normal `browser` araç yüzeyi üzerinden bağlı sekmeyi kontrol eder.

## Kurulum / yükleme (paketsiz)

1. Uzantıyı kararlı bir yerel yola kurun:

```bash
openclaw browser extension install
```

2. Kurulu uzantı dizin yolunu yazdırın:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- “Geliştirici modu”nu etkinleştirin
- “Paketlenmemiş yükle” → yukarıda yazdırılan dizini seçin

4. 20. Uzantıyı sabitleyin.

## Güncellemeler (derleme adımı yok)

Uzantı, OpenClaw sürümünün (npm paketi) içinde statik dosyalar olarak gelir. Ayrı bir “derleme” adımı yoktur.

OpenClaw’ı yükselttikten sonra:

- OpenClaw durum dizininiz altındaki kurulu dosyaları yenilemek için `openclaw browser extension install` komutunu yeniden çalıştırın.
- Chrome → `chrome://extensions` → uzantıda “Yeniden Yükle”ye tıklayın.

## Kullanım (ek yapılandırma yok)

OpenClaw, varsayılan bağlantı noktasında uzantı rölesini hedefleyen `chrome` adlı yerleşik bir tarayıcı profiliyle gelir.

Kullanın:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Ajan aracı: `browser` ile `profile="chrome"`

Farklı bir ad veya farklı bir röle bağlantı noktası istiyorsanız, kendi profilinizi oluşturun:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Bağlama / ayırma (araç çubuğu düğmesi)

- OpenClaw’ın kontrol etmesini istediğiniz sekmeyi açın.
- Uzantı simgesine tıklayın.
  - Bağlıyken rozet `ON` gösterir.
- Ayırmak için tekrar tıklayın.

## Hangi sekmeyi kontrol eder?

- “Baktığınız herhangi bir sekmeyi” otomatik olarak kontrol etmez.
- Yalnızca araç çubuğu düğmesine tıklayarak **açıkça bağladığınız sekme(ler)i** kontrol eder.
- Değiştirmek için: diğer sekmeyi açın ve orada uzantı simgesine tıklayın.

## Rozet + yaygın hatalar

- `ON`: bağlı; OpenClaw bu sekmeyi yönetebilir.
- `…`: yerel röleye bağlanılıyor.
- `!`: röleye erişilemiyor (en yaygını: tarayıcı röle sunucusu bu makinede çalışmıyor).

`!` görürseniz:

- Gateway’in yerel olarak çalıştığından emin olun (varsayılan kurulum) ya da Gateway başka bir yerde çalışıyorsa bu makinede bir node host çalıştırın.
- Uzantı Seçenekler sayfasını açın; rölenin erişilebilir olup olmadığını gösterir.

## Uzak Gateway (node host kullanın)

### Yerel Gateway (Chrome ile aynı makine) — genellikle **ek adım yok**

Gateway, Chrome ile aynı makinede çalışıyorsa tarayıcı kontrol hizmetini loopback üzerinde başlatır
ve röle sunucusunu otomatik başlatır. Uzantı yerel röleyle konuşur; CLI/araç çağrıları Gateway’e gider.

### Uzak Gateway (Gateway başka bir yerde çalışır) — **bir node host çalıştırın**

Gateway başka bir makinede çalışıyorsa, Chrome’un çalıştığı makinede bir node host başlatın.
Gateway, tarayıcı eylemlerini bu node’a proxy’ler; uzantı + röle tarayıcı makinesinde yerel kalır.

Birden fazla node bağlıysa, `gateway.nodes.browser.node` ile birini sabitleyin veya `gateway.nodes.browser.mode` ayarlayın.

## Sandboxing (araç konteynerleri)

Ajan oturumunuz sandboxed ise (`agents.defaults.sandbox.mode != "off"`), `browser` aracı kısıtlanabilir:

- Varsayılan olarak sandboxed oturumlar, ana makinenizdeki Chrome yerine **sandbox tarayıcıyı** (`target="sandbox"`) hedefler.
- Chrome uzantısı rölesi devralma, **ana makine** tarayıcı kontrol sunucusunun kontrol edilmesini gerektirir.

Seçenekler:

- En kolayı: uzantıyı **sandboxed olmayan** bir oturum/ajan ile kullanın.
- Ya da sandboxed oturumlar için ana makine tarayıcı kontrolüne izin verin:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Ardından aracın araç politikası tarafından engellenmediğinden emin olun ve (gerekirse) `browser`’ü `target="host"` ile çağırın.

Hata ayıklama: `openclaw sandbox explain`

## Uzak erişim ipuçları

- Gateway ve node host’u aynı tailnet’te tutun; röle bağlantı noktalarını LAN’a veya genel İnternet’e açmaktan kaçının.
- Node’ları bilinçli olarak eşleştirin; uzaktan kontrol istemiyorsanız tarayıcı proxy yönlendirmesini devre dışı bırakın (`gateway.nodes.browser.mode="off"`).

## “Uzantı yolu” nasıl çalışır

`openclaw browser extension path`, uzantı dosyalarını içeren **kurulu** disk üzerindeki dizini yazdırır.

CLI kasıtlı olarak bir `node_modules` yolu yazdırmaz. Uzantıyı OpenClaw durum dizininiz altında kararlı bir konuma kopyalamak için her zaman önce `openclaw browser extension install`’u çalıştırın.

Bu kurulum dizinini taşırsanız veya silerseniz, Chrome geçerli bir yoldan yeniden yükleyene kadar uzantıyı bozuk olarak işaretler.

## Güvenlik etkileri (bunu okuyun)

Bu güçlü ve risklidir. Model’e “tarayıcınız üzerinde eller” vermek gibi düşünün.

- Uzantı, Chrome’un debugger API’sini (`chrome.debugger`) kullanır. Bağlıyken model:
  - 21. o sekmede tıkla/yaz/navigasyon yap
  - sayfa içeriğini okuyabilir
  - sekmenin oturum açmış olduğu her şeye erişebilir
- **Bu, özel openclaw tarafından yönetilen profil gibi yalıtılmış değildir.**
  - Günlük kullandığınız profile/sekmesine bağlanırsanız, o hesap durumuna erişim vermiş olursunuz.

Öneriler:

- Uzantı rölesi kullanımı için kişisel gezinmenizden ayrı, özel bir Chrome profili tercih edin.
- Gateway ve tüm node host’ları yalnızca tailnet içinde tutun; Gateway kimlik doğrulaması + node eşleştirmesine güvenin.
- Röle bağlantı noktalarını LAN üzerinden açmaktan kaçının (`0.0.0.0`) ve Funnel (genel) kullanmaktan kaçının.
- Röle, uzantı dışı kaynakları engeller ve CDP istemcileri için dahili bir kimlik doğrulama belirteci gerektirir.

İlgili:

- Tarayıcı aracı genel bakış: [Browser](/tools/browser)
- Güvenlik denetimi: [Security](/gateway/security)
- Tailscale kurulumu: [Tailscale](/gateway/tailscale)
