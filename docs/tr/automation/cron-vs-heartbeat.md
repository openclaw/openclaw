---
summary: "Otomasyon için heartbeat ile cron işleri arasında seçim yapmaya yönelik rehber"
read_when:
  - Yinelenen görevlerin nasıl zamanlanacağına karar verirken
  - Arka plan izleme veya bildirimler kurarken
  - Periyodik kontroller için token kullanımını optimize ederken
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Hangisi Ne Zaman Kullanılmalı

Hem heartbeat’ler hem de cron işleri, görevleri bir zaman çizelgesine göre çalıştırmanıza olanak tanır. Bu rehber, kullanım senaryonuz için doğru mekanizmayı seçmenize yardımcı olur.

## Hızlı Karar Rehberi

| Kullanım Senaryosu                               | Önerilen                               | Neden                                                     |
| ------------------------------------------------ | -------------------------------------- | --------------------------------------------------------- |
| Gelen kutusunu her 30 dakikada kontrol et        | Heartbeat                              | Diğer kontrollerle birlikte, bağlam farkındalıklı gruplar |
| Her gün tam 9:00’da rapor gönder | Cron (isolated)     | Kesin zamanlama gerekir                                   |
| Takvimde yaklaşan etkinlikleri izle              | Heartbeat                              | Periyodik farkındalık için doğal uyum                     |
| Haftalık derin analiz çalıştır                   | Cron (isolated)     | Bağımsız görev, farklı model kullanılabilir               |
| 20 dakika sonra hatırlat                         | Cron (main, `--at`) | Hassas zamanlamayla tek seferlik                          |
| Arka plan proje sağlık kontrolü                  | Heartbeat                              | Mevcut döngüyü kullanır                                   |

## Heartbeat: Periyodik Farkındalık

Heartbeat’ler **ana oturumda** düzenli bir aralıkla (varsayılan: 30 dk) çalışır. Ajanın durumu kontrol etmesi ve önemli olanları öne çıkarması için tasarlanmıştır.

### Heartbeat ne zaman kullanılmalı

- **Birden fazla periyodik kontrol**: Gelen kutusu, takvim, hava durumu, bildirimler ve proje durumunu kontrol eden 5 ayrı cron işi yerine, tek bir heartbeat hepsini gruplayabilir.
- **Bağlam farkında kararlar**: Ajan, ana oturumun tam bağlamına sahiptir; bu sayede acil olanlarla bekleyebilecekleri akıllıca ayırt edebilir.
- **Konuşma sürekliliği**: Heartbeat çalışmaları aynı oturumu paylaşır; ajan son konuşmaları hatırlar ve doğal şekilde takip edebilir.
- **Düşük ek yükle izleme**: Tek bir heartbeat, birçok küçük yoklama görevini değiştirir.

### Heartbeat avantajları

- **Birden fazla kontrolü grupla**: Tek bir ajan turu, gelen kutusu, takvim ve bildirimleri birlikte gözden geçirebilir.
- **API çağrılarını azaltır**: Tek bir heartbeat, 5 izole cron işinden daha ucuzdur.
- **Bağlam farkındalığı**: Ajan, üzerinde çalıştıklarınızı bilir ve buna göre önceliklendirebilir.
- **Akıllı bastırma**: Dikkat gerektiren bir şey yoksa, ajan `HEARTBEAT_OK` yanıtını verir ve mesaj teslim edilmez.
- **Doğal zamanlama**: Kuyruk yüküne bağlı olarak hafifçe kayar; çoğu izleme için uygundur.

### Heartbeat örneği: HEARTBEAT.md kontrol listesi

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Ajan bunu her heartbeat’te okur ve tüm maddeleri tek turda ele alır.

### Heartbeat yapılandırması

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Tam yapılandırma için [Heartbeat](/gateway/heartbeat) sayfasına bakın.

## Cron: Kesin Zamanlama

Cron işleri **kesin zamanlarda** çalışır ve ana bağlamı etkilemeden izole oturumlarda çalışabilir.

### Cron ne zaman kullanılmalı

- **Kesin zamanlama gerektiğinde**: “Her Pazartesi sabah 9:00’da gönder” ( “9 civarı” değil).
- **Bağımsız görevler**: Konuşma bağlamına ihtiyaç duymayan işler.
- **Farklı model/düşünme**: Daha güçlü bir modeli gerektiren ağır analizler.
- **Tek seferlik hatırlatmalar**: `--at` ile “20 dakika sonra hatırlat”.
- **Gürültülü/sık görevler**: Ana oturum geçmişini kalabalıklaştıracak işler.
- **Harici tetikleyiciler**: Ajanın başka bir şekilde aktif olup olmamasından bağımsız çalışması gereken görevler.

### Cron avantajları

- **Kesin zamanlama**: Zaman dilimi desteği olan 5 alanlı cron ifadeleri.
- **Oturum izolasyonu**: Ana geçmişi kirletmeden `cron:<jobId>` içinde çalışır.
- **Model geçersiz kılma**: İş başına daha ucuz veya daha güçlü bir model kullanın.
- **Teslimat denetimi**: İzole işler varsayılan olarak `announce` (özet) kullanır; gerektiğinde `none` seçin.
- **Anında teslimat**: Announce modu, heartbeat’i beklemeden doğrudan gönderir.
- **Ajan bağlamı gerekmez**: Ana oturum boşta veya sıkıştırılmış olsa bile çalışır.
- **Tek seferlik destek**: Kesin gelecek zaman damgaları için `--at`.

### Cron örneği: Günlük sabah brifingi

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Bu iş New York saatine göre tam 7:00’da çalışır, kalite için Opus kullanır ve özeti doğrudan WhatsApp’a duyurur.

### Cron örneği: Tek seferlik hatırlatma

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Tam CLI referansı için [Cron jobs](/automation/cron-jobs) sayfasına bakın.

## Karar Akış Şeması

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Her İkisini Birlikte Kullanma

En verimli kurulum **her ikisini de** kullanır:

1. **Heartbeat**, rutin izlemeyi (gelen kutusu, takvim, bildirimler) her 30 dakikada tek bir gruplanmış turda ele alır.
2. **Cron**, kesin zamanlamaları (günlük raporlar, haftalık incelemeler) ve tek seferlik hatırlatmaları yönetir.

### Örnek: Verimli otomasyon kurulumu

**HEARTBEAT.md** (her 30 dakikada kontrol edilir):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron işleri** (kesin zamanlama):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Onaylı deterministik iş akışları

Lobster, **çok adımlı araç boru hatları** için deterministik yürütme ve açık onaylar gerektiren iş akışı çalışma zamanıdır.
Görev tek bir ajan turundan fazlaysa ve insan kontrol noktaları olan, devam ettirilebilir bir iş akışı istiyorsanız kullanın.

### Lobster ne zaman uygundur

- **Çok adımlı otomasyon**: Tek seferlik bir istem değil, sabit bir araç çağrıları hattına ihtiyaç vardır.
- **Onay kapıları**: Yan etkiler, siz onaylayana kadar durmalı ve ardından devam etmelidir.
- **Devam ettirilebilir çalıştırmalar**: Daha önceki adımları yeniden çalıştırmadan duraklatılmış bir iş akışına devam edin.

### Heartbeat ve cron ile nasıl eşleşir

- **Heartbeat/cron**, bir çalıştırmanın _ne zaman_ gerçekleşeceğine karar verir.
- **Lobster**, çalıştırma başladığında _hangi adımların_ gerçekleşeceğini tanımlar.

Zamanlanmış iş akışları için, Lobster’ı çağıran bir ajan turunu tetiklemek üzere cron veya heartbeat kullanın.
Ad-hoc iş akışları için Lobster’ı doğrudan çağırın.

### Operasyonel notlar (koddaki bilgiler)

- Lobster, araç modunda **yerel bir alt süreç** (`lobster` CLI) olarak çalışır ve bir **JSON zarfı** döndürür.
- Araç `needs_approval` döndürürse, `resumeToken` ve `approve` bayrağı ile devam edersiniz.
- Araç **isteğe bağlı bir eklentidir**; `tools.alsoAllow: ["lobster"]` ile eklemeli olarak etkinleştirin (önerilir).
- `lobsterPath` geçirirseniz, **mutlak bir yol** olmalıdır.

Tam kullanım ve örnekler için [Lobster](/tools/lobster) sayfasına bakın.

## Ana Oturum vs İzole Oturum

Hem heartbeat hem de cron ana oturumla etkileşime girebilir, ancak farklı şekillerde:

|        | Heartbeat                            | Cron (main)           | Cron (isolated)    |
| ------ | ------------------------------------ | ---------------------------------------- | ------------------------------------- |
| Oturum | Ana                                  | Ana (sistem olayıyla) | `cron:<jobId>`                        |
| Geçmiş | Paylaşılan                           | Paylaşılan                               | Her çalıştırmada taze                 |
| Bağlam | Tam                                  | Tam                                      | Yok (temiz başlar) |
| Model  | Ana oturum modeli                    | Ana oturum modeli                        | Geçersiz kılabilir                    |
| Çıktı  | `HEARTBEAT_OK` değilse teslim edilir | Heartbeat istemi + olay                  | Varsayılan olarak özet duyurusu       |

### Ana oturum cron ne zaman kullanılmalı

Aşağıdakileri istediğinizde `--session main` ile `--system-event` kullanın:

- Hatırlatmanın/olayın ana oturum bağlamında görünmesi
- Bir sonraki kalp atışı sırasında tam bağlamla ele alması için ajan
- Ayrı bir izole çalıştırma olmaması

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### İzole cron ne zaman kullanılmalı

Aşağıdakileri istediğinizde `--session isolated` kullanın:

- Önceki bağlam olmadan temiz bir başlangıç
- Farklı model veya düşünme ayarları
- Özetleri doğrudan bir kanala duyurmak
- Ana oturumu kalabalıklaştırmayan geçmiş

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Maliyet Hususları

| Mekanizma                          | Maliyet Profili                                                           |
| ---------------------------------- | ------------------------------------------------------------------------- |
| Heartbeat                          | Her N dakikada bir tur; HEARTBEAT.md boyutuyla ölçeklenir |
| Cron (main)     | Bir sonraki heartbeat’e olay ekler (izole tur yok)     |
| Cron (isolated) | İş başına tam ajan turu; daha ucuz model kullanılabilir                   |

**İpuçları**:

- Token ek yükünü en aza indirmek için `HEARTBEAT.md` küçük tutun.
- Birden fazla cron işi yerine benzer kontrolleri heartbeat’te gruplayın.
- Yalnızca dahili işlem istiyorsanız heartbeat’te `target: "none"` kullanın.
- Rutin görevler için daha ucuz bir modelle izole cron kullanın.

## İlgili

- [Heartbeat](/gateway/heartbeat) - tam heartbeat yapılandırması
- [Cron jobs](/automation/cron-jobs) - tam cron CLI ve API referansı
- [System](/cli/system) - sistem olayları + heartbeat kontrolleri
