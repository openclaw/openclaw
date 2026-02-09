---
summary: "Kullanım izleme yüzeyleri ve kimlik bilgisi gereksinimleri"
read_when:
  - Sağlayıcı kullanım/kota yüzeylerini bağlarken
  - Kullanım izleme davranışını veya kimlik doğrulama gereksinimlerini açıklamanız gerektiğinde
title: "Kullanım İzleme"
---

# Kullanım izleme

## Nedir

- Sağlayıcı kullanım/kota bilgilerini doğrudan kendi kullanım uç noktalarından çeker.
- Tahmini maliyet yoktur; yalnızca sağlayıcı tarafından raporlanan pencereler kullanılır.

## Nerede görünür

- Sohbetlerde `/status`: oturum belirteçleri + tahmini maliyet içeren, emoji zengini durum kartı (yalnızca API anahtarı). Sağlayıcı kullanımı, mevcut olduğunda **geçerli model sağlayıcısı** için gösterilir.
- Sohbetlerde `/usage off|tokens|full`: yanıt başına kullanım alt bilgisi (OAuth yalnızca belirteçleri gösterir).
- Sohbetlerde `/usage cost`: OpenClaw oturum günlüklerinden toplanan yerel maliyet özeti.
- CLI: `openclaw status --usage` sağlayıcı başına tam bir döküm yazdırır.
- CLI: `openclaw channels list` aynı kullanım anlık görüntüsünü sağlayıcı yapılandırmasının yanında yazdırır (atlamak için `--no-usage` kullanın).
- macOS menü çubuğu: Context altında “Usage” bölümü (yalnızca mevcutsa).

## Sağlayıcılar + kimlik bilgileri

- **Anthropic (Claude)**: kimlik doğrulama profillerinde OAuth belirteçleri.
- **GitHub Copilot**: kimlik doğrulama profillerinde OAuth belirteçleri.
- **Gemini CLI**: kimlik doğrulama profillerinde OAuth belirteçleri.
- **Antigravity**: kimlik doğrulama profillerinde OAuth belirteçleri.
- **OpenAI Codex**: kimlik doğrulama profillerinde OAuth belirteçleri (mevcut olduğunda accountId kullanılır).
- **MiniMax**: API anahtarı (kodlama planı anahtarı; `MINIMAX_CODE_PLAN_KEY` veya `MINIMAX_API_KEY`); 5 saatlik kodlama planı penceresini kullanır.
- **z.ai**: ortam/yapılandırma/kimlik doğrulama deposu üzerinden API anahtarı.

Eşleşen OAuth/API kimlik bilgileri yoksa kullanım gizlenir.
