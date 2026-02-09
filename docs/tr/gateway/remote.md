---
summary: "SSH tünelleri (Gateway WS) ve tailnet'ler kullanarak uzaktan erişim"
read_when:
  - Uzak gateway kurulumlarını çalıştırırken veya sorun giderirken
title: "Uzaktan Erişim"
---

# Uzaktan erişim (SSH, tüneller ve tailnet'ler)

Bu depo, özel bir ana makinede (masaüstü/sunucu) tek bir Gateway’in (ana) çalışır durumda tutulması ve istemcilerin ona bağlanması yoluyla “SSH üzerinden uzaktan bağlantı”yı destekler.

- **Operatörler (siz / macOS uygulaması)** için: SSH tünelleme evrensel geri dönüş yöntemidir.
- **Düğümler (iOS/Android ve gelecekteki cihazlar)** için: Gateway **WebSocket**’ine bağlanın (gerektikçe LAN/tailnet veya SSH tüneli).

## Temel fikir

- Gateway WebSocket’i, yapılandırılmış portunuzda **loopback**’e bağlanır (varsayılan 18789).
- Uzaktan kullanım için bu loopback portunu SSH üzerinden yönlendirirsiniz (ya da bir tailnet/VPN kullanıp daha az tünel açarsınız).

## Yaygın VPN/tailnet kurulumları (ajanın bulunduğu yer)

**Gateway ana makinesi**ni “ajanın yaşadığı yer” olarak düşünün. Oturumlara, kimlik doğrulama profillerine, kanallara ve duruma sahiptir.
Dizüstü/masaüstünüz (ve düğümler) bu ana makineye bağlanır.

### 1. Tailnet’inizde her zaman açık Gateway (VPS veya ev sunucusu)

Gateway’i kalıcı bir ana makinede çalıştırın ve **Tailscale** veya SSH ile erişin.

- **En iyi UX:** `gateway.bind: "loopback"`’yi koruyun ve Control UI için **Tailscale Serve** kullanın.
- **Geri dönüş:** loopback + erişime ihtiyaç duyan herhangi bir makineden SSH tüneli.
- **Örnekler:** [exe.dev](/install/exe-dev) (kolay VM) veya [Hetzner](/install/hetzner) (üretim VPS).

Bu, dizüstünüz sık sık uykuya geçtiğinde ancak ajanın her zaman açık olmasını istediğinizde idealdir.

### 2. Ev masaüstü Gateway’i çalıştırır, dizüstü uzaktan kontrol eder

Dizüstü **ajanı çalıştırmaz**. Uzaktan bağlanır:

- macOS uygulamasının **SSH üzerinden uzaktan bağlantı** modunu kullanın (Ayarlar → Genel → “OpenClaw runs”).
- Uygulama tüneli açar ve yönetir; böylece WebChat + sağlık kontrolleri “kendiliğinden çalışır”.

Çalıştırma kılavuzu: [macOS uzaktan erişim](/platforms/mac/remote).

### 3. Dizüstü Gateway’i çalıştırır, diğer makinelerden uzaktan erişim

Gateway’i yerelde tutun ancak güvenli biçimde açın:

- Diğer makinelerden dizüstüne SSH tüneli açın veya
- Control UI’yi Tailscale Serve ile sunun ve Gateway’i yalnızca loopback’te tutun.

Kılavuz: [Tailscale](/gateway/tailscale) ve [Web genel bakış](/web).

## Komut akışı (ne nerede çalışır)

Tek bir gateway servisi durum + kanallara sahiptir. Düğümler çevre birimlerdir.

Akış örneği (Telegram → düğüm):

- Telegram mesajı **Gateway**’e ulaşır.
- Gateway **ajanı** çalıştırır ve bir düğüm aracını çağırıp çağırmayacağına karar verir.
- Gateway, **düğümü** Gateway WebSocket üzerinden çağırır (`node.*` RPC).
- Düğüm sonucu döndürür; Gateway Telegram’a yanıt verir.

Notlar:

- **Düğümler gateway servisini çalıştırmaz.** Kasıtlı olarak yalıtılmış profiller çalıştırmıyorsanız (bkz. [Birden çok gateway](/gateway/multiple-gateways)), ana makine başına yalnızca bir gateway çalışmalıdır.
- macOS uygulamasındaki “düğüm modu”, Gateway WebSocket üzerinden çalışan bir düğüm istemcisidir.

## SSH tüneli (CLI + araçlar)

Uzak Gateway WS’ye yerel bir tünel oluşturun:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Tünel açıkken:

- `openclaw health` ve `openclaw status --deep` artık `ws://127.0.0.1:18789` üzerinden uzak gateway’e erişir.
- `openclaw gateway {status,health,send,agent,call}` de gerektiğinde `--url` üzerinden yönlendirilen URL’yi hedefleyebilir.

Not: `18789`’u yapılandırılmış `gateway.port` ile değiştirin (veya `--port`/`OPENCLAW_GATEWAY_PORT`).
Not: `--url` geçildiğinde, CLI yapılandırma veya ortam kimlik bilgilerine geri dönmez.
`--token` veya `--password`’i açıkça ekleyin. Açık kimlik bilgileri eksikse hata oluşur.

## CLI remote defaults

CLI komutlarının varsayılan olarak kullanacağı bir uzak hedefi kalıcı hale getirebilirsiniz:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Gateway yalnızca loopback’teyken, URL’yi `ws://127.0.0.1:18789`’da tutun ve önce SSH tünelini açın.

## SSH üzerinden Chat UI

WebChat artık ayrı bir HTTP portu kullanmıyor. SwiftUI sohbet UI’si doğrudan Gateway WebSocket’ine bağlanır.

- `18789`’yi SSH üzerinden yönlendirin (yukarıya bakın), ardından istemcileri `ws://127.0.0.1:18789`’e bağlayın.
- macOS’ta, tüneli otomatik yöneten uygulamanın “SSH üzerinden uzaktan bağlantı” modunu tercih edin.

## macOS uygulaması “SSH üzerinden uzaktan bağlantı”

macOS menü çubuğu uygulaması aynı kurulumu uçtan uca yönetebilir (uzak durum kontrolleri, WebChat ve Voice Wake yönlendirme).

Çalıştırma kılavuzu: [macOS uzaktan erişim](/platforms/mac/remote).

## Güvenlik kuralları (uzak/VPN)

Kısa sürüm: **Gateway’i yalnızca loopback’te tutun**, bağlama gerektiğinden emin değilseniz.

- **Loopback + SSH/Tailscale Serve** en güvenli varsayılandır (genel erişim yok).
- **Loopback dışı bağlamalar** (`lan`/`tailnet`/`custom` veya loopback kullanılamadığında `auto`) kimlik doğrulama belirteçleri/parolaları kullanmalıdır.
- `gateway.remote.token` **yalnızca** uzaktan CLI çağrıları içindir — yerel kimlik doğrulamayı **etkinleştirmez**.
- `gateway.remote.tlsFingerprint`, `wss://` kullanılırken uzak TLS sertifikasını sabitler.
- **Tailscale Serve**, `gateway.auth.allowTailscale: true` durumunda kimlik başlıklarıyla kimlik doğrulaması yapabilir.
  Belirteç/parola istiyorsanız `false` olarak ayarlayın.
- Tarayıcı kontrolünü operatör erişimi gibi ele alın: yalnızca tailnet + bilinçli düğüm eşleştirme.

Derinlemesine inceleme: [Güvenlik](/gateway/security).
