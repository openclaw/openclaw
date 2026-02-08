---
summary: "`openclaw security` için CLI başvuru belgesi (yaygın güvenlik hatalarını denetleme ve düzeltme)"
read_when:
  - Yapılandırma/durum üzerinde hızlı bir güvenlik denetimi çalıştırmak istiyorsanız
  - Güvenli “düzeltme” önerilerini (chmod, varsayılanları sıkılaştırma) uygulamak istiyorsanız
title: "güvenlik"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:05Z
---

# `openclaw security`

Güvenlik araçları (denetim + isteğe bağlı düzeltmeler).

İlgili:

- Güvenlik kılavuzu: [Güvenlik](/gateway/security)

## Denetim

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Denetim, birden fazla DM göndereninin ana oturumu paylaştığı durumlarda uyarır ve paylaşılan gelen kutuları için **güvenli DM modu**: `session.dmScope="per-channel-peer"` (çoklu hesap kanalları için `per-account-channel-peer`) önerir.
Ayrıca, sandboxing olmadan ve web/tarayıcı araçları etkinleştirilmiş şekilde küçük modellerin (`<=300B`) kullanılması durumunda da uyarır.
