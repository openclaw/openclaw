---
summary: "Terminal UI (TUI): herhangi bir makineden Gateway’e bağlanın"
read_when:
  - TUI için başlangıç dostu bir rehbere ihtiyacınız var
  - TUI özellikleri, komutları ve kısayollarının tam listesine ihtiyacınız var
title: "TUI"
---

# TUI (Terminal UI)

## Hızlı başlangıç

1. Gateway’i başlatın.

```bash
openclaw gateway
```

2. TUI’yi açın.

```bash
openclaw tui
```

3. Bir mesaj yazın ve Enter’a basın.

Uzak Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Gateway’iniz parola doğrulaması kullanıyorsa `--password` kullanın.

## Ne görürsünüz

- Başlık: bağlantı URL’si, geçerli ajan, geçerli oturum.
- Sohbet günlüğü: kullanıcı mesajları, asistan yanıtları, sistem bildirimleri, araç kartları.
- Durum satırı: bağlantı/çalışma durumu (bağlanıyor, çalışıyor, akış, boşta, hata).
- Alt bilgi: bağlantı durumu + ajan + oturum + model + düşünme/ayrıntılı/akıl yürütme + token sayıları + gönderim.
- Girdi: otomatik tamamlama özellikli metin düzenleyici.

## Zihinsel model: ajanlar + oturumlar

- Ajanlar benzersiz slug’lardır (ör. `main`, `research`). Gateway listeyi sunar.
- Sessions belong to the current agent.
- Oturum anahtarları `agent:<agentId>:<sessionKey>` olarak saklanır.
  - `/session main` yazarsanız, TUI bunu `agent:<currentAgent>:main` olarak genişletir.
  - `/session agent:other:main` yazarsanız, o ajan oturumuna açıkça geçersiniz.
- Oturum kapsamı:
  - `per-sender` (varsayılan): her ajanın birden fazla oturumu vardır.
  - `global`: TUI her zaman `global` oturumunu kullanır (seçici boş olabilir).
- Geçerli ajan + oturum her zaman alt bilgide görünür.

## Gönderme + teslim

- Mesajlar Gateway’e gönderilir; sağlayıcılara teslim varsayılan olarak kapalıdır.
- Turn delivery on:
  - `/deliver on`
  - veya Ayarlar panelinden
  - ya da `openclaw tui --deliver` ile başlatın

## Seçiciler + kaplamalar

- Model seçici: kullanılabilir modelleri listeler ve oturum geçersiz kılmasını ayarlar.
- Ajan seçici: farklı bir ajan seçin.
- Oturum seçici: yalnızca geçerli ajan için oturumları gösterir.
- Ayarlar: teslimi, araç çıktısı genişletmesini ve düşünme görünürlüğünü aç/kapatır.

## Klavye kısayolları

- Enter: mesaj gönder
- Esc: etkin çalıştırmayı iptal et
- Ctrl+C: girdiyi temizle (çıkmak için iki kez basın)
- Ctrl+D: çık
- Ctrl+L: model seçici
- Ctrl+G: ajan seçici
- Ctrl+P: oturum seçici
- Ctrl+O: araç çıktısı genişletmesini aç/kapat
- Ctrl+T: düşünme görünürlüğünü aç/kapat (geçmişi yeniden yükler)

## Slash komutları

Çekirdek:

- `/help`
- `/status`
- `/agent <id>` (veya `/agents`)
- `/session <key>` (veya `/sessions`)
- `/model <provider/model>` (veya `/models`)

Oturum denetimleri:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (takma ad: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Oturum yaşam döngüsü:

- `/new` veya `/reset` (oturumu sıfırlar)
- `/abort` (etkin çalıştırmayı iptal eder)
- `/settings`
- `/exit`

Diğer Gateway slash komutları (örneğin `/context`) Gateway’e iletilir ve sistem çıktısı olarak gösterilir. [Slash commands](/tools/slash-commands).

## Yerel kabuk komutları

- Bir satırı `!` ile başlatarak TUI ana makinesinde yerel bir kabuk komutu çalıştırın.
- TUI, yerel yürütmeye izin vermek için oturum başına bir kez sorar; reddedilirse oturum için `!` devre dışı kalır.
- Komutlar, TUI çalışma dizininde yeni ve etkileşimsiz bir kabukta çalışır (kalıcı `cd`/env yoktur).
- Tek başına bir `!` normal bir mesaj olarak gönderilir; baştaki boşluklar yerel çalıştırmayı tetiklemez.

## Araç çıktısı

- Araç çağrıları, argümanlar + sonuçlarla birlikte kartlar olarak gösterilir.
- Ctrl+O, daraltılmış/genişletilmiş görünümler arasında geçiş yapar.
- Araçlar çalışırken, kısmi güncellemeler aynı karta akışla eklenir.

## Geçmiş + akış

- Bağlanırken TUI, en son geçmişi yükler (varsayılan 200 mesaj).
- Akış yanıtları, tamamlanana kadar yerinde güncellenir.
- TUI ayrıca daha zengin araç kartları için ajan araç olaylarını dinler.

## Bağlantı ayrıntıları

- TUI, Gateway’e `mode: "tui"` olarak kaydolur.
- Yeniden bağlanmalar bir sistem mesajı gösterir; olay boşlukları günlükte görünür.

## Seçenekler

- `--url <url>`: Gateway WebSocket URL’si (yapılandırmaya veya `ws://127.0.0.1:<port>`’e varsayılan)
- `--token <token>`: Gateway belirteci (gerekliyse)
- `--password <password>`: Gateway parolası (gerekliyse)
- `--session <key>`: Oturum anahtarı (varsayılan: `main`, kapsam global ise `global`)
- `--deliver`: Asistan yanıtlarını sağlayıcıya teslim et (varsayılan kapalı)
- `--thinking <level>`: Gönderimler için düşünme düzeyini geçersiz kıl
- `--timeout-ms <ms>`: Ajan zaman aşımı (ms) (varsayılan: `agents.defaults.timeoutSeconds`)

Not: `--url` ayarladığınızda, TUI yapılandırma veya ortam kimlik bilgilerine geri dönmez.
`--token` veya `--password`’i açıkça iletin. Açık kimlik bilgilerinin eksik olması bir hatadır.

## Sorun giderme

Mesaj gönderdikten sonra çıktı yoksa:

- Gateway’in bağlı ve boşta/meşgul olduğunu doğrulamak için TUI’de `/status` çalıştırın.
- Gateway günlüklerini kontrol edin: `openclaw logs --follow`.
- Ajanın çalışabildiğini doğrulayın: `openclaw status` ve `openclaw models status`.
- Bir sohbet kanalında mesaj bekliyorsanız, teslimi etkinleştirin (`/deliver on` veya `--deliver`).
- `--history-limit <n>`: Yüklenecek geçmiş girdileri (varsayılan 200)

## Bağlantı sorun giderme

- `disconnected`: Gateway’in çalıştığından ve `--url/--token/--password`’lerinizin doğru olduğundan emin olun.
- Seçicide ajan yok: `openclaw agents list` ve yönlendirme yapılandırmanızı kontrol edin.
- Boş oturum seçici: global kapsamda olabilirsiniz veya henüz oturumunuz yoktur.
