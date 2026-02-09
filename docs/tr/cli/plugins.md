---
summary: "`openclaw plugins` için CLI başvurusu (listeleme, yükleme, etkinleştirme/devre dışı bırakma, doctor)"
read_when:
  - Süreç içi Gateway eklentilerini yüklemek veya yönetmek istiyorsunuz
  - Eklenti yükleme hatalarını ayıklamak istiyorsunuz
title: "plugins"
---

# `openclaw plugins`

Gateway eklentilerini/uzantılarını (süreç içinde yüklenen) yönetin.

İlgili:

- Eklenti sistemi: [Plugins](/tools/plugin)
- Eklenti bildirimi + şema: [Plugin manifest](/plugins/manifest)
- Güvenlik sertleştirme: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Birlikte gelen eklentiler OpenClaw ile birlikte gelir ancak başlangıçta devre dışıdır. Bunları etkinleştirmek için `plugins enable` kullanın.

Tüm eklentiler, satır içi bir JSON Şeması (`configSchema`, boş olsa bile) içeren bir `openclaw.plugin.json` dosyası sağlamalıdır. Eksik/geçersiz bildiriler veya şemalar, eklentinin yüklenmesini engeller ve yapılandırma doğrulamasının başarısız olmasına neden olur.

### Install

```bash
openclaw plugins install <path-or-spec>
```

Güvenlik notu: eklenti kurulumlarını kod çalıştırma gibi değerlendirin. Sabitlenmiş sürümleri tercih edin.

Desteklenen arşivler: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Yerel bir dizini kopyalamaktan kaçınmak için `--link` kullanın (`plugins.load.paths`'e ekler):

```bash
openclaw plugins install -l ./my-plugin
```

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Güncellemeler yalnızca npm'den yüklenen eklentilere uygulanır (`plugins.installs`'te izlenir).
