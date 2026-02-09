---
summary: "apply_patch aracıyla çoklu dosya yamaları uygulayın"
read_when:
  - Birden fazla dosyada yapılandırılmış düzenlemelere ihtiyacınız olduğunda
  - Yama tabanlı düzenlemeleri belgelemek veya hata ayıklamak istediğinizde
title: "apply_patch Aracı"
---

# apply_patch aracı

Yapılandırılmış bir yama biçimi kullanarak dosya değişikliklerini uygulayın. Bu,
tek bir `edit` çağrısının kırılgan olacağı çoklu dosya
veya çoklu hunk düzenlemeleri için idealdir.

Araç, bir veya daha fazla dosya işlemini saran tek bir `input` dizesi kabul eder:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parametreler

- `input` (gerekli): `*** Begin Patch` ve `*** End Patch` dahil olmak üzere tam yama içeriği.

## Notlar

- Yollar, çalışma alanı köküne göre çözülür.
- Dosyaları yeniden adlandırmak için bir `*** Update File:` hunk’ı içinde `*** Move to:` kullanın.
- `*** End of File`, gerektiğinde yalnızca EOF eklemesini işaretler.
- Deneyseldir ve varsayılan olarak devre dışıdır. `tools.exec.applyPatch.enabled` ile etkinleştirin.
- Yalnızca OpenAI (OpenAI Codex dahil). İsteğe bağlı olarak modeli
  `tools.exec.applyPatch.allowModels` üzerinden kısıtlayabilirsiniz.
- Yapılandırma yalnızca `tools.exec` altındadır.

## Örnek

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
