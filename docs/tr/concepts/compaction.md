---
summary: "Bağlam penceresi + sıkıştırma: OpenClaw oturumları model sınırları içinde nasıl tutar"
read_when:
  - Otomatik sıkıştırmayı ve /compact komutunu anlamak istiyorsunuz
  - You are debugging long sessions hitting context limits
title: "Sıkıştırma"
---

# Context Window & Compaction

Her modelin bir **bağlam penceresi** vardır (görebileceği en fazla token sayısı). Uzun süreli sohbetlerde mesajlar ve araç sonuçları birikir; pencere daraldığında OpenClaw, sınırlar içinde kalmak için eski geçmişi **sıkıştırır**.

## Sıkıştırma nedir

Sıkıştırma, **eski konuşmayı özetler** ve kompakt bir özet girdisi oluştururken son mesajları olduğu gibi tutar. Özet, oturum geçmişinde saklanır; böylece sonraki istekler şunları kullanır:

- Sıkıştırma özeti
- Sıkıştırma noktasından sonraki son mesajlar

Sıkıştırma, oturumun JSONL geçmişinde **kalıcıdır**.

## Yapılandırma

`agents.defaults.compaction` ayarları için [Sıkıştırma yapılandırması ve modları](/concepts/compaction) sayfasına bakın.

## Otomatik sıkıştırma (varsayılan açık)

Bir oturum modelin bağlam penceresine yaklaştığında veya aştığında, OpenClaw otomatik sıkıştırmayı tetikler ve sıkıştırılmış bağlamı kullanarak özgün isteği yeniden deneyebilir.

Şunları görürsünüz:

- Ayrıntılı modda `🧹 Auto-compaction complete`
- `🧹 Compactions: <count>`’ü gösteren `/status`

Sıkıştırmadan önce OpenClaw, kalıcı notları diske yazmak için **sessiz bellek boşaltma** adımı çalıştırabilir. Ayrıntılar ve yapılandırma için [Bellek](/concepts/memory) bölümüne bakın.

## Manuel sıkıştırma

Bir sıkıştırma geçişini zorlamak için (isteğe bağlı talimatlarla) `/compact` kullanın:

```
/compact Focus on decisions and open questions
```

## Bağlam penceresi kaynağı

Bağlam penceresi modele özeldir. OpenClaw, sınırları belirlemek için yapılandırılmış sağlayıcı kataloğundaki model tanımını kullanır.

## Compaction vs pruning

- **Sıkıştırma**: özetler ve JSONL’de **kalıcı** olarak saklar.
- **Oturum budaması**: yalnızca eski **araç sonuçlarını** keser, **bellek içi**, istek başına.

Budama ayrıntıları için [/concepts/session-pruning](/concepts/session-pruning) sayfasına bakın.

## İpuçları

- Oturumlar bayat hissettirdiğinde veya bağlam şiştiğinde `/compact` kullanın.
- Büyük araç çıktıları zaten kısaltılır; budama, araç sonucu birikimini daha da azaltabilir.
- Temiz bir başlangıç gerekiyorsa, `/new` veya `/reset` yeni bir oturum kimliği başlatır.
