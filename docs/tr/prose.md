---
summary: "OpenProse: OpenClaw’da .prose iş akışları, slash komutları ve durum"
read_when:
  - .prose iş akışlarını çalıştırmak veya yazmak istiyorsunuz
  - OpenProse eklentisini etkinleştirmek istiyorsunuz
  - Durum depolamayı anlamanız gerekir
title: "OpenProse"
---

# OpenProse

OpenProse, AI oturumlarını orkestre etmek için taşınabilir, markdown-öncelikli bir iş akışı biçimidir. OpenClaw’da, bir OpenProse skill paketi ile bir `/prose` slash komutunu yükleyen bir eklenti olarak sunulur. Programlar `.prose` dosyalarında yaşar ve açık denetim akışıyla birden fazla alt ajan oluşturabilir.

Resmî site: [https://www.prose.md](https://www.prose.md)

## Neler yapabilir

- Açık paralellik ile çok ajanlı araştırma ve sentez.
- Tekrarlanabilir, onay-güvenli iş akışları (kod inceleme, olay triyajı, içerik boru hatları).
- Desteklenen ajan çalışma ortamları arasında çalıştırabileceğiniz, yeniden kullanılabilir `.prose` programları.

## Yükleme + etkinleştirme

Paketlenmiş eklentiler varsayılan olarak devre dışıdır. OpenProse’u etkinleştirin:

```bash
openclaw plugins enable open-prose
```

Eklentiyi etkinleştirdikten sonra Gateway’i yeniden başlatın.

Geliştirme/yerel checkout: `openclaw plugins install ./extensions/open-prose`

İlgili dokümanlar: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash komutu

OpenProse, kullanıcı tarafından çağrılabilen bir skill komutu olarak `/prose` kaydeder. OpenProse VM talimatlarına yönlendirir ve perde arkasında OpenClaw araçlarını kullanır.

Yaygın komutlar:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Örnek: basit bir `.prose` dosyası

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Dosya konumları

OpenProse, çalışma alanınızda durumu `.prose/` altında tutar:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Kullanıcı düzeyinde kalıcı ajanlar şurada bulunur:

```
~/.prose/agents/
```

## Durum modları

OpenProse birden fazla durum arka ucunu destekler:

- **filesystem** (varsayılan): `.prose/runs/...`
- **in-context**: küçük programlar için geçici
- **sqlite** (deneysel): `sqlite3` ikili dosyasını gerektirir
- **postgres** (deneysel): `psql` ve bir bağlantı dizesi gerektirir

Notlar:

- sqlite/postgres isteğe bağlıdır ve deneysel durumdadır.
- postgres kimlik bilgileri alt ajan günlüklerine akar; özel, en az ayrıcalıklı bir VT kullanın.

## Uzak programlar

`/prose run <handle/slug>`, `https://p.prose.md/<handle>/<slug>`’ya çözülür.
Doğrudan URL’ler olduğu gibi getirilir. Bu, `web_fetch` aracını (POST için `exec`) kullanır.

## OpenClaw çalışma zamanı eşlemesi

OpenProse programları OpenClaw ilkel yapılarına eşlenir:

| OpenProse kavramı             | OpenClaw aracı   |
| ----------------------------- | ---------------- |
| Oturum başlatma / Görev aracı | `sessions_spawn` |
| Dosya okuma/yazma             | `read` / `write` |
| Web'den getirme               | `web_fetch`      |

Araç izin listeniz bu araçları engelliyorsa, OpenProse programları başarısız olur. [Skills config](/tools/skills-config) bölümüne bakın.

## Güvenlik + onaylar

`.prose` dosyalarını kod gibi ele alın. Çalıştırmadan önce gözden geçirin. Yan etkileri denetlemek için OpenClaw araç izin listelerini ve onay kapılarını kullanın.

Deterministik, onay kapılı iş akışları için [Lobster](/tools/lobster) ile karşılaştırın.
