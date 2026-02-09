---
summary: "Mesaj akışı, oturumlar, kuyruklama ve muhakeme görünürlüğü"
read_when:
  - Gelen mesajların nasıl yanıt hâline geldiğini açıklarken
  - Oturumları, kuyruklama modlarını veya akış davranışını netleştirirken
  - Muhakeme görünürlüğünü ve kullanım etkilerini belgelendirirken
title: "Mesajlar"
---

# Mesajlar

Bu sayfa, OpenClaw’un gelen mesajları, oturumları, kuyruklamayı,
akışı ve muhakeme görünürlüğünü nasıl ele aldığını bir araya getirir.

## Mesaj akışı (üst düzey)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Key knobs live in configuration:

- Önekler, kuyruklama ve grup davranışı için `messages.*`.
- Blok halinde akış ve parçalama varsayılanları için `agents.defaults.*`.
- Sınırlar ve akış anahtarları için kanal geçersiz kılmaları (`channels.whatsapp.*`, `channels.telegram.*` vb.). for caps and streaming toggles.

Tam şema için [Yapılandırma](/gateway/configuration) bölümüne bakın.

## Inbound dedupe

Kanallar, yeniden bağlanmalardan sonra aynı mesajı yeniden teslim edebilir. OpenClaw,
kanal/hesap/karşı taraf/oturum/mesaj kimliğine göre anahtarlanmış kısa ömürlü bir önbellek tutar;
böylece yinelenen teslimatlar başka bir ajan çalıştırmasını tetiklemez.

## Gelen debouncing

**Aynı gönderenden** gelen hızlı ardışık mesajlar, `messages.inbound` aracılığıyla tek bir
ajan turunda birleştirilebilir. Debouncing, kanal + konuşma bazında kapsamlandırılır
ve yanıt dizileme/kimlikler için en son mesajı kullanır.

Yapılandırma (küresel varsayılan + kanal başına geçersiz kılmalar):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notlar:

- Debounce yalnızca **yalnızca metin** mesajlarına uygulanır; medya/ekler anında gönderimi tetikler.
- Denetim komutları debouncing’i atlar, böylece bağımsız kalırlar.

## Oturumlar ve cihazlar

Oturumlar istemcilere değil, gateway’e aittir.

- Doğrudan sohbetler ajan ana oturum anahtarına daraltılır.
- Gruplar/kanallar kendi oturum anahtarlarını alır.
- The session store and transcripts live on the gateway host.

Birden çok cihaz/kanal aynı oturuma eşlenebilir; ancak geçmiş her istemciye tam olarak
geri senkronize edilmez. Öneri: bağlamın ayrışmasını önlemek için uzun konuşmalarda
tek bir birincil cihaz kullanın. Denetim UI’si ve TUI her zaman gateway destekli
oturum transkriptini gösterir; dolayısıyla doğruluk kaynağı onlardır.

Ayrıntılar: [Oturum yönetimi](/concepts/session).

## Inbound bodies and history context

OpenClaw, **istem gövdesini** **komut gövdesinden** ayırır:

- `Body`: ajana gönderilen istem metni. Buna kanal zarfları ve
  isteğe bağlı geçmiş sarmalayıcıları dâhil olabilir.
- `CommandBody`: yönerge/komut ayrıştırması için ham kullanıcı metni.
- `RawBody`: `CommandBody` için eski takma ad (uyumluluk için tutulur).

Bir kanal geçmiş sağladığında, paylaşılan bir sarmalayıcı kullanır:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**Doğrudan olmayan sohbetlerde** (gruplar/kanallar/odalar), **mevcut mesaj gövdesi**
gönderen etiketiyle öneklenir (geçmiş girdilerinde kullanılan stilin aynısı). Bu, gerçek zamanlı ve kuyruklu/geçmiş mesajları ajan isteminde tutarlı kılar.

Geçmiş arabellekleri **yalnızca bekleyen** öğeleri içerir: bir çalıştırmayı
_tetiklememiş_ grup mesajlarını (ör. mention-korumalı mesajlar) kapsar ve
oturum transkriptinde zaten bulunan mesajları **hariç tutar**.

Yönerge ayıklama yalnızca **mevcut mesaj** bölümüne uygulanır; böylece geçmiş
bozulmadan kalır. Geçmişi saran kanallar, `CommandBody` (veya
`RawBody`) alanını özgün mesaj metnine ayarlamalı ve `Body`’i
birleştirilmiş istem olarak korumalıdır.
Geçmiş arabellekleri `messages.groupChat.historyLimit`
(küresel varsayılan) ve `channels.slack.historyLimit` veya
`channels.telegram.accounts.<id>.historyLimit` gibi kanal başına geçersiz kılmalarla yapılandırılabilir
(devre dışı bırakmak için `0`’u ayarlayın).

## Kuyruklama ve takipler

Bir çalıştırma zaten etkinse, gelen mesajlar kuyruğa alınabilir, mevcut çalıştırmaya
yönlendirilebilir veya bir takip turu için toplanabilir.

- `messages.queue` (ve `messages.queue.byChannel`) ile yapılandırın.
- Modlar: `interrupt`, `steer`, `followup`, `collect` ve birikim (backlog) varyantları.

Ayrıntılar: [Kuyruklama](/concepts/queue).

## Akış, parçalama ve toplu gönderim

Blok halinde akış, model metin blokları ürettikçe kısmi yanıtlar gönderir.
Parçalama, kanal metin sınırlarına uyar ve çitlenmiş kodu bölmeyi önler.

Temel ayarlar:

- `agents.defaults.blockStreamingDefault` (`on|off`, varsayılan kapalı)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (boşta kalma temelli toplu gönderim)
- `agents.defaults.humanDelay` (blok yanıtları arasında insana benzer duraklama)
- Kanal geçersiz kılmaları: `*.blockStreaming` ve `*.blockStreamingCoalesce` (Telegram dışı kanallar açıkça `*.blockStreaming: true` gerektirir)

Ayrıntılar: [Akış + parçalama](/concepts/streaming).

## Muhakeme görünürlüğü ve belirteçler

OpenClaw, model muhakemesini açığa çıkarabilir veya gizleyebilir:

- `/reasoning on|off|stream` görünürlüğü denetler.
- Muhakeme içeriği, model tarafından üretildiğinde belirteç kullanımına yine dâhildir.
- Telegram, muhakemenin taslak balonuna akışını destekler.

Ayrıntılar: [Düşünme + muhakeme yönergeleri](/tools/thinking) ve [Belirteç kullanımı](/reference/token-use).

## Önekler, dizileme ve yanıtlar

Giden mesaj biçimlendirmesi `messages` içinde merkezileştirilmiştir:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` ve `channels.<channel>.accounts.<id>.responsePrefix` (giden önek kademesi), ayrıca `channels.whatsapp.messagePrefix` (WhatsApp gelen öneki)
- `replyToMode` ve kanal başına varsayılanlar aracılığıyla yanıt dizileme

Ayrıntılar: [Yapılandırma](/gateway/configuration#messages) ve kanal belgeleri.
