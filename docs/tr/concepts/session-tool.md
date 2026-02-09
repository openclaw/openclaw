---
summary: "Oturumları listeleme, geçmişi alma ve oturumlar arası mesaj gönderme için ajan oturum araçları"
read_when:
  - Oturum araçları eklerken veya değiştirirken
title: "Oturum Araçları"
---

# Oturum Araçları

Amaç: Ajanların oturumları listeleyebilmesi, geçmişi alabilmesi ve başka bir oturuma mesaj gönderebilmesi için küçük ve yanlış kullanımı zor bir araç seti.

## Araç Adları

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Anahtar Modeli

- Ana doğrudan sohbet kovası her zaman tam olarak `"main"` anahtarıdır (geçerli ajanın ana anahtarına çözümlenir).
- Grup sohbetleri `agent:<agentId>:<channel>:group:<id>` veya `agent:<agentId>:<channel>:channel:<id>` kullanır (tam anahtarı geçin).
- Cron işleri `cron:<job.id>` kullanır.
- Hook’lar açıkça ayarlanmadıkça `hook:<uuid>` kullanır.
- Node oturumları açıkça ayarlanmadıkça `node-<nodeId>` kullanır.

`global` ve `unknown` ayrılmış değerlerdir ve asla listelenmez. `session.scope = "global"` olduğunda, çağıranların `global`’yı hiç görmemesi için tüm araçlarda `main`’e takma ad verilir.

## sessions_list

Oturumları satır dizisi olarak listeler.

Parametreler:

- `kinds?: string[]` filtresi: `"main" | "group" | "cron" | "hook" | "node" | "other"`’den herhangi biri
- `limit?: number` azami satır sayısı (varsayılan: sunucu varsayılanı, örn. 200’e sıkıştırılır)
- `activeMinutes?: number` yalnızca son N dakika içinde güncellenen oturumlar
- `messageLimit?: number` 0 = mesaj yok (varsayılan 0); >0 = son N mesajı dahil et

Davranış:

- `messageLimit > 0`, oturum başına `chat.history` getirir ve son N mesajı dahil eder.
- Araç sonuçları liste çıktısından filtrelenir; araç mesajları için `sessions_history` kullanın.
- **sandboxed** bir ajan oturumunda çalışırken, oturum araçları varsayılan olarak **yalnızca-spawned görünürlüğü**ne sahiptir (aşağıya bakın).

Satır şekli (JSON):

- `key`: oturum anahtarı (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (varsa grup görüntü etiketi)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (ayarlıysa oturum geçersiz kılması)
- `lastChannel`, `lastTo`
- `deliveryContext` (mümkün olduğunda normalize edilmiş `{ channel, to, accountId }`)
- `transcriptPath` (depo dizini + sessionId’den türetilen en iyi çaba yolu)
- `messages?` (yalnızca `messageLimit > 0` olduğunda)

## sessions_history

Tek bir oturum için dökümü getirir.

Parametreler:

- `sessionKey` (zorunlu; `sessions_list`’dan oturum anahtarını veya `sessionId`’u kabul eder)
- `limit?: number` azami mesaj sayısı (sunucu sınırlar)
- `includeTools?: boolean` (varsayılan false)

Davranış:

- `includeTools=false`, `role: "toolResult"` mesajlarını filtreler.
- Mesajlar dizisini ham döküm biçiminde döndürür.
- Bir `sessionId` verildiğinde, OpenClaw bunu karşılık gelen oturum anahtarına çözümler (eksik kimlikler hatası).

## sessions_send

Başka bir oturuma mesaj gönderir.

Parametreler:

- `sessionKey` (zorunlu; `sessions_list`’den oturum anahtarını veya `sessionId`’yi kabul eder)
- `message` (zorunlu)
- `timeoutSeconds?: number` (varsayılan >0; 0 = ateşle-ve-unut)

Davranış:

- `timeoutSeconds = 0`: kuyruğa alır ve `{ runId, status: "accepted" }` döndürür.
- `timeoutSeconds > 0`: tamamlanma için N saniyeye kadar bekler, ardından `{ runId, status: "ok", reply }` döndürür.
- Bekleme zaman aşımına uğrarsa: `{ runId, status: "timeout", error }`. Çalışma devam eder; daha sonra `sessions_history`’yı çağırın.
- Çalışma başarısız olursa: `{ runId, status: "error", error }`.
- Duyuru teslimi, birincil çalışma tamamlandıktan sonra çalışır ve en iyi çaba esaslıdır; `status: "ok"`, duyurunun teslim edildiğini garanti etmez.
- Bekleme, gateway `agent.wait` (sunucu tarafı) üzerinden yapılır; böylece yeniden bağlanmalar beklemeyi düşürmez.
- Agent-to-agent message context is injected for the primary run.
- Birincil çalışma tamamlandıktan sonra OpenClaw bir **yanıt-geri döngüsü** çalıştırır:
  - Round 2+ alternates between requester and target agents.
  - Ping‑pong’u durdurmak için tam olarak `REPLY_SKIP` yanıtlayın.
  - Azami tur sayısı `session.agentToAgent.maxPingPongTurns`’dir (0–5, varsayılan 5).
- Döngü sona erdiğinde OpenClaw **ajan‑ajan duyuru adımı**nı çalıştırır (yalnızca hedef ajan):
  - Sessiz kalmak için tam olarak `ANNOUNCE_SKIP` yanıtlayın.
  - Diğer herhangi bir yanıt hedef kanala gönderilir.
  - Duyuru adımı, özgün istek + 1. tur yanıtı + en son ping‑pong yanıtını içerir.

## Kanal Alanı

- Gruplar için, `channel` oturum kaydında kaydedilen kanaldır.
- Doğrudan sohbetler için, `channel`, `lastChannel`’ten eşlenir.
- Cron/hook/node için, `channel` `internal`’dir.
- Eksikse, `channel` `unknown`’dir.

## Güvenlik / Gönderim Politikası

Kanal/sohbet türüne göre politika tabanlı engelleme (oturum kimliğine göre değil).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Çalışma zamanı geçersiz kılması (oturum girdisi başına):

- `sendPolicy: "allow" | "deny"` (ayarlanmamış = yapılandırmayı devral)
- `sessions.patch` veya yalnızca sahibine ait `/send on|off|inherit` (bağımsız mesaj) ile ayarlanabilir.

Uygulama noktaları:

- `chat.send` / `agent` (gateway)
- otomatik yanıt teslim mantığı

## sessions_spawn

Spawn a sub-agent run in an isolated session and announce the result back to the requester chat channel.

Parametreler:

- `task` (zorunlu)
- `label?` (isteğe bağlı; günlükler/UI için kullanılır)
- `agentId?` (isteğe bağlı; izin veriliyorsa başka bir ajan kimliği altında başlat)
- `model?` (isteğe bağlı; alt‑ajan modelini geçersiz kılar; geçersiz değerler hatadır)
- `runTimeoutSeconds?` (varsayılan 0; ayarlandığında, N saniye sonra alt‑ajan çalışmasını iptal eder)
- `cleanup?` (`delete|keep`, varsayılan `keep`)

İzin listesi:

- `agents.list[].subagents.allowAgents`: `agentId` aracılığıyla izin verilen ajan kimlikleri listesi (`["*"]` herhangi birine izin vermek için). Varsayılan: yalnızca istekte bulunan ajan.

Keşif:

- `sessions_spawn` için hangi ajan kimliklerine izin verildiğini keşfetmek üzere `agents_list` kullanın.

Davranış:

- `deliver: false` ile yeni bir `agent:<agentId>:subagent:<uuid>` oturumu başlatır.
- Alt‑ajanlar varsayılan olarak **oturum araçları hariç** tam araç setine sahiptir (`tools.subagents.tools` ile yapılandırılabilir).
- Alt‑ajanların `sessions_spawn` çağırmasına izin verilmez (alt‑ajan → alt‑ajan başlatma yok).
- Her zaman engellemesizdir: `{ status: "accepted", runId, childSessionKey }`’yi hemen döndürür.
- Tamamlandıktan sonra OpenClaw bir alt‑ajan **duyuru adımı** çalıştırır ve sonucu istekte bulunan sohbet kanalına gönderir.
- Duyuru adımı sırasında sessiz kalmak için tam olarak `ANNOUNCE_SKIP` yanıtlayın.
- Duyuru yanıtları `Status`/`Result`/`Notes` olarak normalize edilir; `Status` çalışma zamanı sonucundan gelir (model metninden değil).
- Alt‑ajan oturumları `agents.defaults.subagents.archiveAfterMinutes` sonra otomatik olarak arşivlenir (varsayılan: 60).
- Duyuru yanıtları bir istatistik satırı içerir (çalışma süresi, token’lar, sessionKey/sessionId, döküm yolu ve isteğe bağlı maliyet).

## Sandbox Oturum Görünürlüğü

Sandboxed oturumlar oturum araçlarını kullanabilir; ancak varsayılan olarak yalnızca `sessions_spawn` aracılığıyla başlattıkları oturumları görürler.

Yapılandırma:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
