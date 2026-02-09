---
summary: "iOS ve diğer uzak düğümler için Gateway’ye ait düğüm eşleştirmesi (Seçenek B)"
read_when:
  - macOS kullanıcı arayüzü olmadan düğüm eşleştirme onaylarının uygulanması
  - Uzak düğümleri onaylamak için CLI akışlarının eklenmesi
  - Gateway protokolünün düğüm yönetimiyle genişletilmesi
title: "Gateway-Owned Pairing"
---

# Gateway’ye ait eşleştirme (Seçenek B)

Gateway’ye ait eşleştirmede, **Gateway (Ağ Geçidi)** hangi düğümlerin katılmasına izin verildiği konusunda tek doğruluk kaynağıdır. Kullanıcı arayüzleri (macOS uygulaması, gelecekteki istemciler) yalnızca bekleyen istekleri onaylayan veya reddeden ön yüzlerdir.

**Önemli:** WS düğümleri, `connect` sırasında **cihaz eşleştirmesi** (rol `node`) kullanır.
`node.pair.*` ayrı bir eşleştirme deposudur ve WS el sıkışmasını **kontrol etmez**.
Yalnızca `node.pair.*` çağrısını açıkça yapan istemciler bu akışı kullanır.

## Kavramlar

- **Bekleyen istek**: katılmak isteyen bir düğüm; onay gerektirir.
- **Eşleştirilmiş düğüm**: onaylanmış ve bir kimlik doğrulama belirteci verilmiş düğüm.
- **Taşıma**: Gateway WS uç noktası istekleri iletir ancak üyeliğe karar vermez. (Eski TCP köprü desteği kullanım dışıdır/kaldırılmıştır.)

## Eşleştirme nasıl çalışır

1. Bir düğüm Gateway WS’ye bağlanır ve eşleştirme talep eder.
2. Gateway bir **bekleyen istek** saklar ve `node.pair.requested` yayar.
3. İsteği onaylar veya reddedersiniz (CLI veya UI).
4. Onaylandığında, Gateway **yeni bir belirteç** verir (yeniden eşleştirmede belirteçler döndürülür).
5. Düğüm belirteci kullanarak yeniden bağlanır ve artık “eşleştirilmiş” olur.

Bekleyen istekler **5 dakika** sonra otomatik olarak sona erer.

## CLI iş akışı (başsız ortamlara uygun)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status`, eşleştirilmiş/bağlı düğümleri ve yeteneklerini gösterir.

## API yüzeyi (gateway protokolü)

Olaylar:

- `node.pair.requested` — yeni bir bekleyen istek oluşturulduğunda yayımlanır.
- `node.pair.resolved` — bir istek onaylandığında/reddedildiğinde/süresi dolduğunda yayımlanır.

Yöntemler:

- `node.pair.request` — bir bekleyen istek oluşturur veya yeniden kullanır.
- `node.pair.list` — bekleyen + eşleştirilmiş düğümleri listeler.
- `node.pair.approve` — bir bekleyen isteği onaylar (belirteç verir).
- `node.pair.reject` — bir bekleyen isteği reddeder.
- `node.pair.verify` — `{ nodeId, token }` doğrular.

Notlar:

- `node.pair.request` düğüm başına idempotenttir: tekrarlanan çağrılar aynı
  bekleyen isteği döndürür.
- Onay **her zaman** yeni bir belirteç üretir; `node.pair.request` hiçbir zaman
  belirteç döndürmez.
- İstekler, otomatik onay akışları için bir ipucu olarak `silent: true` içerebilir.

## Otomatik onay (macOS uygulaması)

macOS uygulaması, aşağıdaki durumlarda isteğe bağlı olarak **sessiz onay** denemesi yapabilir:

- istek `silent` olarak işaretliyse ve
- uygulama, aynı kullanıcıyı kullanarak gateway ana makinesine bir SSH bağlantısını doğrulayabiliyorsa.

Sessiz onay başarısız olursa, normal “Onayla/Reddet” istemine geri düşer.

## Depolama (yerel, özel)

Eşleştirme durumu Gateway durum dizini altında saklanır (varsayılan `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR`’yi geçersiz kılarsanız, `nodes/` klasörü onunla birlikte taşınır.

Güvenlik notları:

- Belirteçler gizlidir; `paired.json`’ü hassas kabul edin.
- Bir belirteci döndürmek yeniden onay gerektirir (veya düğüm girdisini silmek).

## Taşıma davranışı

- Taşıma **durumsuzdur**; üyeliği saklamaz.
- Gateway çevrimdışıysa veya eşleştirme devre dışıysa, düğümler eşleştirilemez.
- Gateway uzak moddaysa, eşleştirme yine uzak Gateway’nin deposuna karşı gerçekleşir.
