---
title: CI Pipeline
description: OpenClaw CI pipeline nasıl çalışır
summary: "CI iş grafiği, scope kapıları ve yerel komut eşdeğerleri"
read_when:
  - Bir CI işinin neden çalıştığını veya çalışmadığını anlamanız gerekiyorsa
  - Başarısız GitHub Actions kontrollerini ayıklıyorsanız
---

# CI Pipeline

CI, `main`'e her itmede ve her pull request'te çalışır. Yalnızca ilgisiz alanlar değiştiğinde pahalı işleri atlamak için akıllı kapsam kullanır.

## İş Genel Bakış

| İş               | Amaç                                                   | Ne Zaman Çalışır                     |
| ----------------- | ------------------------------------------------------- | ---------------------------------- |
| `docs-scope`      | Yalnızca docs değişikliklerini tespit et                | Her zaman                           |
| `changed-scope`   | Hangi alanların değiştiğini tespit et (node/macos/android/windows) | Docs dışı değişiklikler                |
| `check`           | TypeScript tip kontrolü, lint, format                  | Docs dışı, node değişiklikleri             |
| `check-docs`      | Markdown lint + bozuk bağlantı kontrolü               | Docs değişti                       |
| `secrets`         | Sızdırılmış secret'leri tespit et                     | Her zaman                           |
| `build-artifacts` | dist'i bir kez build et, `release-check` ile paylaş   | `main`'e itmeler, node değişiklikleri     |
| `release-check`   | npm pack içeriğini doğrula                              | `main`'e itmelerde build'den sonra       |
| `checks`          | Node testleri + PR'lerde protokol kontrolü; push'te Bun uyumluluğu | Docs dışı, node değişiklikleri             |
| `compat-node22`   | Minimum desteklenen Node runtime uyumluluğu            | `main`'e itmeler, node değişiklikleri     |
| `checks-windows`  | Windows'a özel testler                                  | Docs dışı, windows ilgili değişiklikler |
| `macos`           | Swift lint/build/test + TS testleri                     | macos değişiklikleri olan PR'ler             |
| `android`         | Gradle build + testleri                                 | Docs dışı, android değişiklikleri          |

## Fail-Fast Sırası

İşler, ucuz kontroller pahalı olanlardan önce başarısız olacak şekilde sıralanmıştır:

1. `docs-scope` + `changed-scope` + `check` + `secrets` (paralel, ucuz kapılar önce)
2. PR'ler: `checks` (Linux Node test 2 parçaya bölünmüş), `checks-windows`, `macos`, `android`
3. `main`'e itmeler: `build-artifacts` + `release-check` + Bun uyumluluğu + `compat-node22`

Kapsam mantığı `scripts/ci-changed-scope.mjs`'te bulunur ve `src/scripts/ci-changed-scope.test.ts`'teki birim testleriyle kapsanmıştır.

## Koşucular

| Koşucu                           | İşler                                       |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | Kapsam tespiti dahil çoğu Linux işi |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`, `ios`                             |

## Yerel Eşdeğerler

```bash
pnpm check          # tip kontrolü + lint + format
pnpm test           # vitest testleri
pnpm check:docs     # docs formatı + lint + bozuk bağlantılar
pnpm release:check  # npm pack doğrulaması
```
