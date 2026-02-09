---
summary: "/think + /verbose için direktif söz dizimi ve bunların model akıl yürütmesini nasıl etkilediği"
read_when:
  - Thinking veya verbose direktif ayrıştırmasını ya da varsayılanlarını ayarlarken
title: "Thinking Düzeyleri"
---

# Thinking Düzeyleri (/think direktifleri)

## Ne yapar

- Herhangi bir gelen içerikte satır içi direktif: `/t <level>`, `/think:<level>` veya `/thinking <level>`.
- Düzeyler (takma adlar): `off | minimal | low | medium | high | xhigh` (yalnızca GPT-5.2 + Codex modelleri)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (maksimum bütçe)
  - xhigh → “ultrathink+” (yalnızca GPT-5.2 + Codex modelleri)
  - `x-high`, `x_high`, `extra-high`, `extra high` ve `extra_high`, `xhigh`’a eşlenir.
  - `highest`, `max`, `high`’ye eşlenir.
- Sağlayıcı notları:
  - Z.AI (`zai/*`) yalnızca ikili thinking’i (`on`/`off`) destekler. `off` olmayan herhangi bir düzey `on` olarak ele alınır (`low`’e eşlenir).

## Çözümleme sırası

1. Mesaj üzerindeki satır içi direktif (yalnızca o mesaja uygulanır).
2. Oturum geçersiz kılma (yalnızca direktif içeren bir mesaj gönderilerek ayarlanır).
3. Genel varsayılan (yapılandırmadaki `agents.defaults.thinkingDefault`).
4. Geri dönüş: akıl yürütebilen modeller için low; diğerleri için kapalı.

## Oturum varsayılanını ayarlama

- **Yalnızca** direktiften oluşan bir mesaj gönderin (boşluklara izin verilir), ör. `/think:medium` veya `/t high`.
- Bu, geçerli oturum için geçerli olur (varsayılan olarak gönderen bazında); `/think:off` ile veya oturum boşta sıfırlamasıyla temizlenir.
- Bir onay yanıtı gönderilir (`Thinking level set to high.` / `Thinking disabled.`). Düzey geçersizse (örn. `/thinking big`), komut bir ipucuyla reddedilir ve oturum durumu değiştirilmez.
- Mevcut thinking düzeyini görmek için `/think` (veya `/think:`)’yi argümansız gönderin.

## Application by agent

- **Gömülü Pi**: çözümlenen düzey, süreç içi Pi ajan çalışma zamanına iletilir.

## Verbose direktifleri (/verbose veya /v)

- Düzeyler: `on` (minimal) | `full` | `off` (varsayılan).
- Yalnızca direktiften oluşan mesaj, oturum verbose’unu değiştirir ve `Verbose logging enabled.` / `Verbose logging disabled.` ile yanıtlar; geçersiz düzeyler durumu değiştirmeden bir ipucu döndürür.
- `/verbose off`, açık bir oturum geçersiz kılmasını saklar; Sessions UI üzerinden `inherit` seçilerek temizleyin.
- Satır içi direktif yalnızca o mesaja etki eder; aksi halde oturum/genel varsayılanlar uygulanır.
- Mevcut verbose düzeyini görmek için `/verbose` (veya `/verbose:`)’yı argümansız gönderin.
- Verbose açıkken, yapılandırılmış araç sonuçları üreten ajanlar (Pi, diğer JSON ajanları) her araç çağrısını, mümkün olduğunda `<emoji> <tool-name>: <arg>` (yol/komut) önekiyle, kendi metadata‑yalnız mesajı olarak geri gönderir. Bu araç özetleri, her araç başladığı anda (ayrı baloncuklar) gönderilir; akış deltaları olarak gönderilmez.
- Verbose `full` olduğunda, araç çıktıları tamamlandıktan sonra da iletilir (ayrı baloncuk, güvenli bir uzunluğa kısaltılır). Çalışma devam ederken `/verbose on|full|off`’u değiştirirseniz, sonraki araç baloncukları yeni ayara uyar.

## Akıl yürütme görünürlüğü (/reasoning)

- Düzeyler: `on|off|stream`.
- Yalnızca direktiften oluşan mesaj, yanıtlarda thinking bloklarının gösterilip gösterilmeyeceğini değiştirir.
- Etkinleştirildiğinde, akıl yürütme `Reasoning:` önekiyle **ayrı bir mesaj** olarak gönderilir.
- `stream` (yalnızca Telegram): yanıt üretilirken akıl yürütmeyi Telegram taslak baloncuğuna akıtır, ardından akıl yürütme olmadan nihai yanıtı gönderir.
- Takma ad: `/reason`.
- Mevcut akıl yürütme düzeyini görmek için `/reasoning` (veya `/reasoning:`)’i argümansız gönderin.

## İlgili

- Elevated mod belgeleri [Elevated mode](/tools/elevated) altında yer alır.

## Heartbeat’ler

- Heartbeat yoklama gövdesi, yapılandırılmış heartbeat istemidir (varsayılan: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Heartbeat mesajındaki satır içi direktifler her zamanki gibi uygulanır (ancak heartbeat’lerden oturum varsayılanlarını değiştirmekten kaçının).
- Heartbeat teslimi varsayılan olarak yalnızca nihai yükü gönderir. Ayrı `Reasoning:` mesajını da (mevcutsa) göndermek için `agents.defaults.heartbeat.includeReasoning: true` veya ajan başına `agents.list[].heartbeat.includeReasoning: true` ayarlayın.

## Web sohbet UI

- Web sohbet thinking seçici, sayfa yüklendiğinde gelen oturum deposu/yapılandırmasından saklanan oturum düzeyini yansıtır.
- Başka bir düzey seçmek yalnızca bir sonraki mesaja uygulanır (`thinkingOnce`); gönderimden sonra seçici, saklanan oturum düzeyine geri döner.
- Oturum varsayılanını değiştirmek için daha önce olduğu gibi bir `/think:<level>` direktifi gönderin; seçici bir sonraki yeniden yüklemeden sonra bunu yansıtacaktır.
