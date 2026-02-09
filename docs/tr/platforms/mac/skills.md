---
summary: "macOS Skills ayarları kullanıcı arayüzü ve Gateway destekli durum"
read_when:
  - macOS Skills ayarları kullanıcı arayüzünü güncellerken
  - Skills kısıtlamalarını veya yükleme davranışını değiştirirken
title: "Skills"
---

# Skills (macOS)

macOS uygulaması OpenClaw Skills’i gateway üzerinden sunar; Skills’i yerel olarak ayrıştırmaz.

## Veri kaynağı

- `skills.status` (gateway) tüm Skills’i, uygunluk durumunu ve eksik gereksinimleri
  (paketli Skills için izin listesi engelleri dahil) döndürür.
- Gereksinimler, her bir `SKILL.md` içindeki `metadata.openclaw.requires`’den türetilir.

## Yükleme eylemleri

- `metadata.openclaw.install` yükleme seçeneklerini (brew/node/go/uv) tanımlar.
- Uygulama, gateway ana makinesinde yükleyicileri çalıştırmak için `skills.install`’ü çağırır.
- Birden fazla seçenek sağlandığında gateway yalnızca tek bir tercih edilen yükleyiciyi sunar
  (varsa brew; aksi halde `skills.install`’ten node yöneticisi, varsayılan npm).

## Ortam/API anahtarları

- Uygulama anahtarları `~/.openclaw/openclaw.json` içinde `skills.entries.<skillKey>` altında saklar.
- `skills.update`, `enabled`, `apiKey` ve `env`’i yamalar.

## Uzaktan mod

- Yükleme ve yapılandırma güncellemeleri yerel Mac’te değil, gateway ana makinesinde gerçekleşir.
