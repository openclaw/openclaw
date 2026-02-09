---
summary: "Alt ajanlar: sonuçları istekte bulunan sohbet kanalına duyuran, izole ajan çalıştırmaları oluşturma"
read_when:
  - Ajan üzerinden arka plan/paralel çalışma istiyorsunuz
  - sessions_spawn veya alt ajan araç politikasını değiştiriyorsunuz
title: "50. Alt Ajanlar"
---

# Sub-agents

Alt ajanlar, mevcut bir ajan çalıştırmasından oluşturulan arka plan ajan çalıştırmalarıdır. Kendi oturumlarında (`agent:<agentId>:subagent:<uuid>`) çalışırlar ve tamamlandıklarında sonuçlarını istekte bulunan sohbet kanalına **duyururlar**.

## Slash komutu

**Mevcut oturum** için alt ajan çalıştırmalarını incelemek veya kontrol etmek üzere `/subagents` kullanın:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` çalıştırma meta verilerini gösterir (durum, zaman damgaları, oturum kimliği, transkript yolu, temizlik).

Birincil hedefler:

- Ana çalıştırmayı engellemeden “araştırma / uzun görev / yavaş araç” işlerini paralelleştirmek.
- Alt ajanları varsayılan olarak izole tutmak (oturum ayrımı + isteğe bağlı sandboxing).
- Araç yüzeyini yanlış kullanımı zorlaştıracak şekilde tutmak: alt ajanlar varsayılan olarak oturum araçlarını **almaz**.
- Avoid nested fan-out: sub-agents cannot spawn sub-agents.

Maliyet notu: her alt ajanın **kendi** bağlamı ve token kullanımı vardır. Ağır veya tekrarlayan
görevler için alt ajanlar adına daha ucuz bir model ayarlayın ve ana ajanınızı daha yüksek kaliteli bir modelde tutun.
Bunu `agents.defaults.subagents.model` üzerinden veya ajan başına geçersiz kılmalarla yapılandırabilirsiniz.

## Araç

`sessions_spawn` kullanın:

- Bir alt ajan çalıştırması başlatır (`deliver: false`, global hat: `subagent`)
- Ardından bir duyuru adımı çalıştırır ve duyuru yanıtını istekte bulunan sohbet kanalına gönderir
- Varsayılan model: `agents.defaults.subagents.model` (veya ajan başına `agents.list[].subagents.model`) ayarlamazsanız çağıranı devralır; açık bir `sessions_spawn.model` her zaman önceliklidir.
- Varsayılan düşünme: `agents.defaults.subagents.thinking` (veya ajan başına `agents.list[].subagents.thinking`) ayarlamazsanız çağıranı devralır; açık bir `sessions_spawn.thinking` her zaman önceliklidir.

Araç parametreleri:

- `task` (gerekli)
- `label?` (isteğe bağlı)
- `agentId?` (isteğe bağlı; izin verilirse başka bir ajan kimliği altında oluşturur)
- `model?` (isteğe bağlı; alt ajan modelini geçersiz kılar; geçersiz değerler atlanır ve alt ajan varsayılan modelle çalışır; araç sonucunda bir uyarı yer alır)
- `thinking?` (isteğe bağlı; alt ajan çalıştırması için düşünme seviyesini geçersiz kılar)
- `runTimeoutSeconds?` (varsayılan `0`; ayarlandığında alt ajan çalıştırması N saniye sonra iptal edilir)
- `cleanup?` (`delete|keep`, varsayılan `keep`)

İzin listesi:

- `agents.list[].subagents.allowAgents`: `agentId` aracılığıyla hedeflenebilecek ajan kimliklerinin listesi (`["*"]` herhangi birine izin vermek için). Varsayılan: yalnızca istekte bulunan ajan.

Keşif:

- `agents_list` kullanarak `sessions_spawn` için şu anda izin verilen ajan kimliklerini görün.

Otomatik arşivleme:

- Alt ajan oturumları `agents.defaults.subagents.archiveAfterMinutes` sonra otomatik olarak arşivlenir (varsayılan: 60).
- Arşivleme `sessions.delete` kullanır ve transkripti `*.deleted.<timestamp>` olarak yeniden adlandırır (aynı klasör).
- `cleanup: "delete"` duyurudan hemen sonra arşivler (yeniden adlandırma yoluyla transkripti yine de tutar).
- Otomatik arşivleme en iyi çaba esaslıdır; gateway yeniden başlatılırsa bekleyen zamanlayıcılar kaybolur.
- `runTimeoutSeconds` otomatik arşivlemez; yalnızca çalıştırmayı durdurur. Oturum, otomatik arşivlemeye kadar kalır.

## Kimlik doğrulama

Alt ajan kimlik doğrulaması oturum türüne göre değil, **ajan kimliğine** göre çözülür:

- Alt ajan oturum anahtarı `agent:<agentId>:subagent:<uuid>`’dur.
- Kimlik doğrulama deposu o ajanın `agentDir`’ından yüklenir.
- Ana ajanın kimlik doğrulama profilleri **yedek** olarak birleştirilir; çakışmalarda ajan profilleri ana profillerin üzerine yazar.

Not: birleştirme ekleyicidir; bu nedenle ana profiller her zaman yedek olarak kullanılabilir. Ajan başına tamamen izole kimlik doğrulama henüz desteklenmemektedir.

## Duyuru

Alt ajanlar bir duyuru adımıyla geri bildirim yapar:

- The announce step runs inside the sub-agent session (not the requester session).
- Alt ajan yanıtı tam olarak `ANNOUNCE_SKIP` ise, hiçbir şey gönderilmez.
- Aksi halde duyuru yanıtı, bir takip `agent` çağrısı (`deliver=true`) aracılığıyla istekte bulunan sohbet kanalına gönderilir.
- Duyuru yanıtları, mevcut olduğunda iş parçacığı/konu yönlendirmesini korur (Slack iş parçacıkları, Telegram konuları, Matrix iş parçacıkları).
- Duyuru mesajları kararlı bir şablona normalize edilir:
  - Çalıştırma sonucundan türetilen `Status:` (`success`, `error`, `timeout` veya `unknown`).
  - Duyuru adımındaki özet içeriği `Result:` (yoksa `(not available)`).
  - `Notes:` hata ayrıntıları ve diğer yararlı bağlam.
- `Status` model çıktısından çıkarılmaz; çalışma zamanı sonuç sinyallerinden gelir.

Duyuru yükleri, sonunda (sarmalandığında bile) bir istatistik satırı içerir:

- Çalışma süresi (örn., `runtime 5m12s`)
- Token kullanımı (girdi/çıktı/toplam)
- Model fiyatlandırması yapılandırıldığında tahmini maliyet (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` ve transkript yolu (ana ajanın `sessions_history` aracılığıyla geçmişi alabilmesi veya dosyayı disk üzerinde inceleyebilmesi için)

## Araç Politikası (alt ajan araçları)

Varsayılan olarak alt ajanlar, **oturum araçları hariç tüm araçları** alır:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Yapılandırma üzerinden geçersiz kılma:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Eşzamanlılık

Alt ajanlar, süreç içi özel bir kuyruk hattı kullanır:

- Hat adı: `subagent`
- Eşzamanlılık: `agents.defaults.subagents.maxConcurrent` (varsayılan `8`)

## Stopping

- İstekte bulunan sohbette `/stop` gönderilmesi, istekte bulunan oturumu iptal eder ve ondan oluşturulmuş tüm etkin alt ajan çalıştırmalarını durdurur.

## Sınırlamalar

- Alt ajan duyurusu **en iyi çaba** esaslıdır. Gateway yeniden başlatılırsa, bekleyen “geri duyur” işleri kaybolur.
- Alt ajanlar hâlâ aynı gateway süreç kaynaklarını paylaşır; `maxConcurrent`’yı bir güvenlik supabı olarak değerlendirin.
- `sessions_spawn` her zaman engellemesizdir: `{ status: "accepted", runId, childSessionKey }`’yi hemen döndürür.
- Alt ajan bağlamı yalnızca `AGENTS.md` + `TOOLS.md` enjekte eder (`SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` veya `BOOTSTRAP.md` yoktur).
