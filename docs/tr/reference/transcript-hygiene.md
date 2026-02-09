---
summary: "Referans: sağlayıcıya özgü transkript temizleme ve onarma kuralları"
read_when:
  - Transkript biçimine bağlı sağlayıcı istek reddedilmelerini ayıklarken
  - Transkript temizleme veya araç çağrısı onarım mantığını değiştiriyorsun
  - Sağlayıcılar arasında araç çağrısı kimliği uyuşmazlıklarını araştırıyorsun
title: "Düşünce imzası temizliği"
---

# Transkript Hijyeni (Sağlayıcı Düzeltmeleri)

Bu belge, bir çalıştırma öncesinde (model bağlamı oluşturulurken) transkriptlere uygulanan **sağlayıcıya özgü düzeltmeleri** açıklar. Bunlar, katı sağlayıcı gereksinimlerini karşılamak için kullanılan **bellek içi** ayarlamalardır. Bu hijyen adımları disk üzerindeki saklanan JSONL transkriptini **yeniden yazmaz**; ancak ayrı bir oturum-dosyası onarım geçişi, oturum yüklenmeden önce geçersiz satırları düşürerek bozuk JSONL dosyalarını yeniden yazabilir. Bir onarım gerçekleştiğinde, özgün dosya oturum dosyasının yanında yedeklenir.

Kapsam şunları içerir:

- Araç-çağrısı kimliği temizleme
- Araç çağrısı girdi doğrulaması
- Araç sonucu eşleştirme onarımı
- Tur doğrulama / sıralama
- Düşünce imzası temizliği
- Görsel yükü temizleme

Transkript depolama ayrıntılarına ihtiyacınız varsa, bkz.:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Nerede çalışır

Tüm transkript hijyeni gömülü çalıştırıcıda merkezileştirilmiştir:

- İlke seçimi: `src/agents/transcript-policy.ts`
- Temizleme/onarma uygulaması: `sanitizeSessionHistory` içinde `src/agents/pi-embedded-runner/google.ts`

İlke, neyin uygulanacağına karar vermek için `provider`, `modelApi` ve `modelId` kullanır.

Transkript hijyeninden ayrı olarak, oturum dosyaları yüklemeden önce (gerekirse) onarılır:

- `repairSessionFileIfNeeded` içinde `src/agents/session-file-repair.ts`
- `run/attempt.ts` ve `compact.ts` tarafından çağrılır (gömülü çalıştırıcı)

---

## Küresel kural: görsel temizleme

Görsel yükleri, boyut sınırları nedeniyle sağlayıcı taraflı reddi önlemek için her zaman temizlenir
(aşırı büyük base64 görsellerin küçültülmesi/yeniden sıkıştırılması).

Uygulama:

- `sanitizeSessionMessagesImages` içinde `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` içinde `src/agents/tool-images.ts`

---

## Küresel kural: bozuk araç çağrıları

Hem `input` hem de `arguments` eksik olan yardımcı araç-çağrısı blokları,
model bağlamı oluşturulmadan önce düşürülür. Bu, kısmen kalıcı hâle gelmiş araç çağrılarından
(kotalama sınırı hatasından sonra gibi) kaynaklanan sağlayıcı reddedilmelerini önler.

Uygulama:

- `sanitizeToolCallInputs` içinde `src/agents/session-transcript-repair.ts`
- `sanitizeSessionHistory` içinde `src/agents/pi-embedded-runner/google.ts`’da uygulanır

---

## Sağlayıcı matrisi (mevcut davranış)

**OpenAI / OpenAI Codex**

- Yalnızca görsel temizleme.
- OpenAI Responses/Codex’e model geçişinde, yetim akıl yürütme imzalarını düşür (ardından içerik bloğu gelmeyen bağımsız akıl yürütme öğeleri).
- Araç-çağrısı kimliği temizleme yok.
- Araç sonucu eşleştirme onarımı yok.
- Tur doğrulama veya yeniden sıralama yok.
- Sentetik araç sonuçları yok.
- Düşünce imzası ayıklama yok.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Araç-çağrısı kimliği temizleme: katı alfasayısal.
- Araç sonucu eşleştirme onarımı ve sentetik araç sonuçları.
- Tur doğrulama (Gemini tarzı tur dönüşümü).
- Google tur sıralama düzeltmesi (geçmiş asistanla başlıyorsa küçük bir kullanıcı önyüklemesi ekler).
- Antigravity Claude: düşünme imzalarını normalize et; imzasız düşünme bloklarını düşür.

**Anthropic / Minimax (Anthropic uyumlu)**

- Araç sonucu eşleştirme onarımı ve sentetik araç sonuçları.
- Tur doğrulama (katı dönüşümü sağlamak için ardışık kullanıcı turlarını birleştir).

**Mistral (model-id tabanlı algılama dâhil)**

- Araç-çağrısı kimliği temizleme: strict9 (9 uzunluklu alfasayısal).

**OpenRouter Gemini**

- Düşünce imzası temizliği: base64 olmayan `thought_signature` değerlerini ayıkla (base64’ü koru).

**Diğer her şey**

- Yalnızca görsel temizleme.

---

## Tarihsel davranış (2026.1.22 öncesi)

2026.1.22 sürümünden önce OpenClaw, birden fazla transkript hijyeni katmanı uyguluyordu:

- Her bağlam oluşturma sırasında çalışan bir **transkript-temizleme uzantısı** vardı ve şunları yapabiliyordu:
  - Araç kullanımı/sonuç eşleştirmesini onarmak.
  - Araç-çağrısı kimliklerini temizlemek ( `_`/`-`’yi koruyan katı olmayan bir mod dâhil).
- Çalıştırıcı ayrıca sağlayıcıya özgü temizleme yapıyor ve bu da işi yinelemeye yol açıyordu.
- Sağlayıcı ilkesinin dışında ek mutasyonlar gerçekleşiyordu; bunlar arasında:
  - Kalıcı hâle getirmeden önce yardımcı metninden `<final>` etiketlerini ayıklamak.
  - Boş yardımcı hata turlarını düşürmek.
  - Araç çağrılarından sonra yardımcı içeriğini kırpmak.

Bu karmaşıklık, sağlayıcılar arası gerilemelere neden oldu (özellikle `openai-responses`
`call_id|fc_id` eşleştirmesi). 2026.1.22 temizliği uzantıyı kaldırdı, mantığı çalıştırıcıda merkezileştirdi
ve OpenAI’yi görsel temizleme dışında **dokunulmaz** hâle getirdi.
