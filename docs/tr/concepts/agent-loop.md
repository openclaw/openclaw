---
summary: "Ajan döngüsü yaşam döngüsü, akışlar ve bekleme semantiği"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
title: "Agent Loop"
---

# Ajan Döngüsü (OpenClaw)

Ajanik bir döngü, bir ajanın tam “gerçek” çalıştırmasıdır: alım → bağlamın birleştirilmesi → model çıkarımı →
araç yürütme → akış halinde yanıtlar → kalıcılık. Bu, bir mesajı eylemlere ve nihai bir yanıta dönüştüren,
oturum durumunu tutarlı tutan yetkili yoldur.

OpenClaw’da bir döngü, oturum başına tekil ve serileştirilmiş bir çalıştırmadır; model düşünürken, araçları
çağırırken ve çıktıyı akış halinde gönderirken yaşam döngüsü ve akış olayları üretir. Bu doküman, bu özgün
döngünün uçtan uca nasıl bağlandığını açıklar.

## Giriş noktaları

- Gateway RPC: `agent` ve `agent.wait`.
- CLI: `agent` komutu.

## Nasıl çalışır (üst düzey)

1. `agent` RPC parametreleri doğrular, oturumu çözümler (sessionKey/sessionId), oturum meta verisini kalıcı hale getirir ve hemen `{ runId, acceptedAt }` döndürür.
2. `agentCommand` ajanı çalıştırır:
   - model + düşünme/ayrıntı varsayılanlarını çözümler
   - Skills anlık görüntüsünü yükler
   - `runEmbeddedPiAgent`’yı (pi-agent-core çalışma zamanı) çağırır
   - emits **lifecycle end/error** if the embedded loop does not emit one
3. `runEmbeddedPiAgent`:
   - oturum başına ve global kuyruklar üzerinden çalıştırmaları serileştirir
   - modeli + kimlik doğrulama profilini çözümler ve pi oturumunu oluşturur
   - pi olaylarına abone olur ve asistan/araç deltalarını akış halinde iletir
   - zaman aşımını uygular -> aşılırsa çalıştırmayı iptal eder
   - yükleri + kullanım meta verisini döndürür
4. `subscribeEmbeddedPiSession`, pi-agent-core olaylarını OpenClaw `agent` akışına köprüler:
   - araç olayları => `stream: "tool"`
   - asistan deltaları => `stream: "assistant"`
   - yaşam döngüsü olayları => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait`, `waitForAgentJob` kullanır:
   - `runId` için **yaşam döngüsü bitiş/hata**yı bekler
   - `{ status: ok|error|timeout, startedAt, endedAt, error? }` döndürür

## Kuyruklama + eşzamanlılık

- Çalıştırmalar, oturum anahtarı başına (oturum şeridi) ve isteğe bağlı olarak global bir şerit üzerinden serileştirilir.
- Bu, araç/oturum yarışlarını önler ve oturum geçmişini tutarlı tutar.
- Mesajlaşma kanalları, bu şerit sistemini besleyen kuyruk modlarını (collect/steer/followup) seçebilir.
  [Command Queue](/concepts/queue).

## Oturum + çalışma alanı hazırlığı

- Çalışma alanı çözümlenir ve oluşturulur; sandbox’lı çalıştırmalar bir sandbox çalışma alanı köküne yönlendirebilir.
- Skills yüklenir (veya bir anlık görüntüden yeniden kullanılır) ve ortama ile isteme enjekte edilir.
- Bootstrap/bağlam dosyaları çözümlenir ve sistem istemi raporuna enjekte edilir.
- Bir oturum yazma kilidi alınır; `SessionManager` akıştan önce açılır ve hazırlanır.

## İstem oluşturma + sistem istemi

- Sistem istemi, OpenClaw’ın temel istemi, Skills istemi, bootstrap bağlamı ve çalıştırma başına geçersiz kılmalarla oluşturulur.
- Modele özgü sınırlar ve sıkıştırma için ayrılan belirteçler uygulanır.
- Modelin ne gördüğü için [System prompt](/concepts/system-prompt) bölümüne bakın.

## Kanca noktaları (nerede araya girebilirsiniz)

OpenClaw’da iki kanca sistemi vardır:

- **Dahili kancalar** (Gateway kancaları): komutlar ve yaşam döngüsü olayları için olay güdümlü betikler.
- **Eklenti kancaları**: ajan/araç yaşam döngüsü ve gateway hattı içindeki genişletme noktaları.

### Dahili kancalar (Gateway kancaları)

- **`agent:bootstrap`**: sistem istemi kesinleşmeden önce bootstrap dosyaları oluşturulurken çalışır.
  Bootstrap bağlam dosyaları eklemek/kaldırmak için bunu kullanın.
- **Komut kancaları**: `/new`, `/reset`, `/stop` ve diğer komut olayları (Hooks belgesine bakın).

Kurulum ve örnekler için [Hooks](/automation/hooks) bölümüne bakın.

### Eklenti kancaları (ajan + gateway yaşam döngüsü)

Bunlar ajan döngüsü veya gateway hattı içinde çalışır:

- **`before_agent_start`**: çalıştırma başlamadan önce bağlam enjekte eder veya sistem istemini geçersiz kılar.
- **`agent_end`**: tamamlandıktan sonra nihai mesaj listesini ve çalıştırma meta verisini inceler.
- **`before_compaction` / `after_compaction`**: sıkıştırma döngülerini gözlemler veya notlar.
- **`before_tool_call` / `after_tool_call`**: araç parametrelerini/sonuçlarını yakalar.
- **`tool_result_persist`**: araç sonuçlarını oturum dökümüne yazılmadan önce senkron olarak dönüştürür.
- **`message_received` / `message_sending` / `message_sent`**: gelen + giden mesaj kancaları.
- **`session_start` / `session_end`**: oturum yaşam döngüsü sınırları.
- **`gateway_start` / `gateway_stop`**: gateway yaşam döngüsü olayları.

Kanca API’si ve kayıt ayrıntıları için [Plugins](/tools/plugin#plugin-hooks) bölümüne bakın.

## Akış + kısmi yanıtlar

- Asistan deltaları pi-agent-core’dan akış halinde alınır ve `assistant` olayları olarak yayılır.
- Blok halinde akış, kısmi yanıtları `text_end` veya `message_end` üzerinde yayabilir.
- Akıl yürütme akışı ayrı bir akış olarak veya blok yanıtlar olarak yayılabilir.
- Parçalama ve blok yanıt davranışı için [Streaming](/concepts/streaming) bölümüne bakın.

## Araç yürütme + mesajlaşma araçları

- Araç başlatma/güncelleme/bitiş olayları `tool` akışında yayılır.
- Araç sonuçları, günlüğe kaydetmeden/yaymadan önce boyut ve görsel yükler açısından temizlenir.
- Mesajlaşma aracı gönderimleri, yinelenen asistan onaylarını bastırmak için izlenir.

## Yanıt şekillendirme + bastırma

- Final payloads are assembled from:
  - assistant text (and optional reasoning)
  - satır içi araç özetleri (ayrıntı açık + izinliyse)
  - model hata verdiğinde asistan hata metni
- `NO_REPLY`, sessiz bir belirteç olarak kabul edilir ve giden yüklerden filtrelenir.
- Mesajlaşma aracı yinelenmeleri nihai yük listesinden kaldırılır.
- Görsellenebilir yük kalmazsa ve bir araç hata verdiyse, bir yedek araç hata yanıtı yayılır
  (bir mesajlaşma aracı zaten kullanıcıya görünür bir yanıt göndermediyse).

## Sıkıştırma + yeniden denemeler

- Otomatik sıkıştırma `compaction` akış olaylarını yayar ve bir yeniden denemeyi tetikleyebilir.
- Yeniden denemede, yinelenen çıktıyı önlemek için bellek içi arabellekler ve araç özetleri sıfırlanır.
- Sıkıştırma hattı için [Compaction](/concepts/compaction) bölümüne bakın.

## Olay akışları (bugün)

- `lifecycle`: `subscribeEmbeddedPiSession` tarafından yayılır (ve yedek olarak `agentCommand` tarafından)
- `assistant`: pi-agent-core’dan akış halinde deltalar
- `tool`: pi-agent-core’dan akış halinde araç olayları

## Sohbet kanalı işleme

- Asistan deltaları, sohbet `delta` mesajlarına arabelleğe alınır.
- **Yaşam döngüsü bitiş/hata** durumunda bir sohbet `final` yayılır.

## Zaman aşımları

- `agent.wait` varsayılan: 30 sn (yalnızca bekleme). `timeoutMs` parametresiyle geçersiz kılınır.
- Ajan çalışma zamanı: `agents.defaults.timeoutSeconds` varsayılan 600 sn; `runEmbeddedPiAgent` iptal zamanlayıcısında uygulanır.

## Where things can end early

- Ajan zaman aşımı (iptal)
- AbortSignal (iptal)
- Gateway bağlantı kesilmesi veya RPC zaman aşımı
- `agent.wait` zaman aşımı (yalnızca bekleme, ajanı durdurmaz)
