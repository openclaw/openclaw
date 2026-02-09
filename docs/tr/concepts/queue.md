---
summary: "Gelen otomatik yanıt çalıştırmalarını seri hale getiren komut kuyruğu tasarımı"
read_when:
  - Otomatik yanıt yürütmesini veya eşzamanlılığını değiştirirken
title: "Komut Kuyruğu"
---

# Command Queue (2026-01-16)

Gelen otomatik yanıt çalıştırmalarını (tüm kanallar) küçük, süreç içi bir kuyruk üzerinden seri hale getiririz; böylece birden fazla ajan çalıştırmasının çakışmasını önlerken, oturumlar arasında güvenli paralelliğe izin veririz.

## Neden

- Otomatik yanıt çalıştırmaları pahalı olabilir (LLM çağrıları) ve birden fazla gelen mesaj kısa aralıklarla geldiğinde çakışabilir.
- Seri hale getirme, paylaşılan kaynaklar (oturum dosyaları, günlükler, CLI stdin) için rekabeti önler ve üst akış hız sınırlarına takılma olasılığını azaltır.

## Nasıl çalışır

- Şerit (lane) farkındalıklı bir FIFO kuyruk, her şeridi yapılandırılabilir bir eşzamanlılık üst sınırıyla boşaltır (yapılandırılmamış şeritler için varsayılan 1; main varsayılan 4, subagent 8).
- `runEmbeddedPiAgent`, **oturum anahtarı**na göre (şerit `session:<key>`) kuyruğa alır; böylece oturum başına yalnızca bir etkin çalıştırma garanti edilir.
- Her oturum çalıştırması daha sonra **küresel bir şerit**e (varsayılan olarak `main`) alınır; böylece genel paralellik `agents.defaults.maxConcurrent` ile sınırlandırılır.
- Ayrıntılı günlükleme etkinleştirildiğinde, kuyruğa alınan çalıştırmalar başlatılmadan önce ~2 sn’den fazla bekledilerse kısa bir bildirim üretir.
- Yazma göstergeleri (kanal destekliyorsa) kuyruğa alma anında tetiklenmeye devam eder; bu sayede sıramızı beklerken kullanıcı deneyimi değişmez.

## Kuyruk modları (kanal başına)

Gelen mesajlar, mevcut çalıştırmayı yönlendirebilir, bir takip turunu bekleyebilir veya her ikisini de yapabilir:

- `steer`: mevcut çalıştırmaya hemen enjekte eder (bir sonraki araç sınırından sonra bekleyen araç çağrılarını iptal eder). Akış yoksa takip turuna geri düşer.
- `followup`: mevcut çalıştırma bittikten sonra bir sonraki ajan turu için kuyruğa alır.
- `collect`: kuyruğa alınmış tüm mesajları **tek** bir takip turunda birleştirir (varsayılan). Mesajlar farklı kanalları/iş parçacıklarını hedefliyorsa, yönlendirmeyi korumak için ayrı ayrı boşaltılır.
- `steer-backlog` (diğer adıyla `steer+backlog`): şimdi yönlendirir **ve** mesajı bir takip turu için korur.
- `interrupt` (eski): o oturum için etkin çalıştırmayı iptal eder, ardından en yeni mesajı çalıştırır.
- `queue` (eski takma ad): `steer` ile aynıdır.

Steer-backlog, yönlendirilmiş çalıştırmadan sonra bir takip yanıtı alabileceğiniz anlamına gelir; bu nedenle
akış yüzeylerinde yinelenmiş gibi görünebilir. Gelen mesaj başına tek yanıt istiyorsanız
`collect`/`steer`’ü tercih edin.
`/queue collect`’i bağımsız bir komut olarak (oturum başına) gönderin veya `messages.queue.byChannel.discord: "collect"`’yı ayarlayın.

Varsayılanlar (yapılandırmada ayarlanmadığında):

- Tüm yüzeyler → `collect`

`messages.queue` üzerinden genel olarak veya kanal başına yapılandırın:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Kuyruk seçenekleri

Seçenekler `followup`, `collect` ve `steer-backlog` için geçerlidir (ve takip turuna geri düştüğünde `steer` için):

- `debounceMs`: bir takip turu başlatmadan önce sakinleşmeyi bekler (“devam et, devam et”i önler).
- `cap`: oturum başına en fazla kuyruğa alınan mesaj sayısı.
- `drop`: taşma politikası (`old`, `new`, `summarize`).

Summarize, düşürülen mesajların kısa bir madde işaretli listesini tutar ve bunu sentetik bir takip istemi olarak enjekte eder.
Varsayılanlar: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Per-session overrides

- Mevcut oturum için modu saklamak üzere `/queue <mode>`’yi bağımsız bir komut olarak gönderin.
- Seçenekler birleştirilebilir: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` veya `/queue reset` oturum geçersiz kılmasını temizler.

## Kapsam ve garantiler

- Gateway yanıt hattını kullanan tüm gelen kanallarda otomatik yanıt ajan çalıştırmalarına uygulanır (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat vb.).
- Varsayılan şerit (`main`), gelen + ana heartbeat’ler için süreç genelidir; birden fazla oturumun paralel çalışmasına izin vermek için `agents.defaults.maxConcurrent`’yi ayarlayın.
- Arka plan işlerinin gelen yanıtları engellemeden paralel çalışabilmesi için ek şeritler bulunabilir (ör. `cron`, `subagent`).
- Oturum başına şeritler, belirli bir oturuma aynı anda yalnızca bir ajan çalıştırmasının dokunmasını garanti eder.
- Harici bağımlılık veya arka plan worker iş parçacıkları yoktur; saf TypeScript + promise’ler.

## Sorun Giderme

- Komutlar takılı gibi görünüyorsa, ayrıntılı günlükleri etkinleştirin ve kuyruğun boşaldığını doğrulamak için “queued for …ms” satırlarını arayın.
- Kuyruk derinliğine ihtiyaç duyuyorsanız, ayrıntılı günlükleri etkinleştirin ve kuyruk zamanlama satırlarını izleyin.
