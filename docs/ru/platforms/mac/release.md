---
summary: "Чек-лист выпуска OpenClaw для macOS (фид Sparkle, упаковка, подписание)"
read_when:
  - При создании или валидации выпуска OpenClaw для macOS
  - При обновлении appcast Sparkle или связанных ресурсов фида
title: "Выпуск macOS"
---

# Выпуск OpenClaw для macOS (Sparkle)

Это приложение теперь поставляется с автообновлениями Sparkle. Релизные сборки должны быть подписаны Developer ID, упакованы в zip и опубликованы с подписанной записью appcast.

## Предварительные запросы

- Установлен сертификат Developer ID Application (пример: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Путь к приватному ключу Sparkle задан в переменных окружения как `SPARKLE_PRIVATE_KEY_FILE` (путь к вашему приватному ключу Sparkle ed25519; публичный ключ вшит в Info.plist). Если он отсутствует, проверьте `~/.profile`.
- Учётные данные нотарификации (профиль Keychain или ключ API) для `xcrun notarytool`, если требуется распространение DMG/zip, совместимое с Gatekeeper.
  - Мы используем профиль Keychain с именем `openclaw-notary`, созданный из переменных окружения ключа API App Store Connect в профиле вашей оболочки:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Установлены зависимости `pnpm` (`pnpm install --config.node-linker=hoisted`).
- Инструменты Sparkle автоматически загружаются через SwiftPM по пути `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast` и т. д.).

## Сборка и упаковка

Примечания:

- `APP_BUILD` сопоставляется с `CFBundleVersion`/`sparkle:version`; поддерживайте числовое и монотонное значение (без `-beta`), иначе Sparkle будет считать его равным.
- По умолчанию используется текущая архитектура (`$(uname -m)`). Для релизных/универсальных сборок установите `BUILD_ARCHS="arm64 x86_64"` (или `BUILD_ARCHS=all`).
- Используйте `scripts/package-mac-dist.sh` для релизных артефактов (zip + DMG + нотарификация). Используйте `scripts/package-mac-app.sh` для локальной/дев-сборки.

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.6.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.6.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.6.dSYM.zip
```

## Запись appcast

Используйте генератор заметок о выпуске, чтобы Sparkle отображал форматированные HTML-заметки:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Генерирует HTML-заметки о выпуске из `CHANGELOG.md` (через [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) и встраивает их в запись appcast.
Зафиксируйте обновлённый `appcast.xml` вместе с релизными артефактами (zip + dSYM) при публикации.

## Публикация и проверка

- Загрузите `OpenClaw-2026.2.6.zip` (и `OpenClaw-2026.2.6.dSYM.zip`) в релиз GitHub для тега `v2026.2.6`.
- Убедитесь, что сырой URL appcast соответствует встроенному фиду: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Быстрые проверки:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` возвращает 200.
  - `curl -I <enclosure url>` возвращает 200 после загрузки артефактов.
  - На предыдущей публичной сборке запустите «Проверить обновления…» на вкладке «О программе» и убедитесь, что Sparkle корректно устанавливает новую сборку.

Критерий готовности: подписанное приложение и appcast опубликованы, процесс обновления работает из ранее установленной версии, а релизные артефакты прикреплены к релизу GitHub.
