---
summary: "Пошаговый чек‑лист релиза для npm + приложения macOS"
read_when:
  - Выпуск нового релиза npm
  - Выпуск нового релиза приложения macOS
  - Проверка метаданных перед публикацией
---

# Чек‑лист релиза (npm + macOS)

Используйте `pnpm` (Node 22+) из корня репозитория. Перед тегированием/публикацией убедитесь, что рабочее дерево чистое.

## Триггер оператора

Когда оператор говорит «release», немедленно выполните этот preflight (без дополнительных вопросов, если не заблокировано):

- Прочитайте этот документ и `docs/platforms/mac/release.md`.
- Загрузите переменные окружения из `~/.profile` и подтвердите, что `SPARKLE_PRIVATE_KEY_FILE` и переменные App Store Connect установлены (SPARKLE_PRIVATE_KEY_FILE должен находиться в `~/.profile`).
- При необходимости используйте ключи Sparkle из `~/Library/CloudStorage/Dropbox/Backup/Sparkle`.

1. **Версия и метаданные**

- [ ] Увеличьте версию `package.json` (например, `2026.1.29`).
- [ ] Запустите `pnpm plugins:sync`, чтобы выровнять версии пакетов расширений и журналы изменений.
- [ ] Обновите строки CLI/версии: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) и user agent Baileys в [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Подтвердите метаданные пакета (name, description, repository, keywords, license) и то, что карта `bin` указывает на [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) для `openclaw`.
- [ ] Если зависимости изменились, запустите `pnpm install`, чтобы `pnpm-lock.yaml` был актуален.

2. **Сборка и артефакты**

- [ ] Если входные данные A2UI изменились, запустите `pnpm canvas:a2ui:bundle` и закоммитьте любые обновлённые [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (перегенерирует `dist/`).
- [ ] Убедитесь, что npm‑пакет `files` включает все необходимые папки `dist/*` (в частности `dist/node-host/**` и `dist/acp/**` для headless‑узла и ACP CLI).
- [ ] Подтвердите, что `dist/build-info.json` существует и содержит ожидаемый хеш `commit` (баннер CLI использует его для установок из npm).
- [ ] Необязательно: `npm pack --pack-destination /tmp` после сборки; проверьте содержимое tarball и сохраните его для релиза GitHub (**не** коммитьте его).

3. **Changelog и документация**

- [ ] Обновите `CHANGELOG.md` с пользовательскими ключевыми изменениями (создайте файл, если отсутствует); держите записи строго по убыванию версий.
- [ ] Убедитесь, что примеры и флаги в README соответствуют текущему поведению CLI (особенно новые команды или параметры).

4. **Валидация**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (или `pnpm test:coverage`, если нужен вывод покрытия)
- [ ] `pnpm release:check` (проверяет содержимое npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (smoke‑тест установки Docker, быстрый путь; обязателен перед релизом)
  - Если предыдущий npm‑релиз заведомо сломан, установите `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` или `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` для шага preinstall.
- [ ] (Необязательно) Полный smoke‑тест установщика (добавляет покрытие non‑root + CLI): `pnpm test:install:smoke`
- [ ] (Необязательно) E2E установщика (Docker, запускает `curl -fsSL https://openclaw.ai/install.sh | bash`, выполняет онбординг, затем реальные вызовы инструментов):
  - `pnpm test:install:e2e:openai` (требуется `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (требуется `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (требуются оба ключа; запускает обоих провайдеров)
- [ ] (Необязательно) Точечно проверьте веб‑Gateway (шлюз), если изменения затрагивают пути отправки/приёма.

5. **Приложение macOS (Sparkle)**

- [ ] Соберите и подпишите приложение macOS, затем упакуйте его в zip для распространения.
- [ ] Сгенерируйте appcast Sparkle (HTML‑заметки через [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) и обновите `appcast.xml`.
- [ ] Держите zip приложения (и необязательный zip dSYM) готовыми для прикрепления к релизу GitHub.
- [ ] Следуйте [macOS release](/platforms/mac/release) для точных команд и требуемых переменных окружения.
  - `APP_BUILD` должен быть числовым и монотонным (без `-beta`), чтобы Sparkle корректно сравнивал версии.
  - При нотарификации используйте профиль ключей `openclaw-notary`, созданный из переменных окружения App Store Connect API (см. [macOS release](/platforms/mac/release)).

6. **Публикация (npm)**

- [ ] Подтвердите, что git‑статус чистый; при необходимости закоммитьте и отправьте изменения.
- [ ] `npm login` (проверка 2FA) при необходимости.
- [ ] `npm publish --access public` (используйте `--tag beta` для pre‑release).
- [ ] Проверьте реестр: `npm view openclaw version`, `npm view openclaw dist-tags` и `npx -y openclaw@X.Y.Z --version` (или `--help`).

### Устранение неполадок (заметки из релиза 2.0.0-beta2)

- **npm pack/publish зависает или создаёт огромный tarball**: бандл приложения macOS в `dist/OpenClaw.app` (и релизные zip) попадает в пакет. Исправление — белый список содержимого публикации через `package.json` `files` (включить подкаталоги dist, docs, skills; исключить бандлы приложений). Подтвердите с помощью `npm pack --dry-run`, что `dist/OpenClaw.app` отсутствует в списке.
- **Цикл веб‑аутентификации npm для dist‑tags**: используйте legacy‑аутентификацию, чтобы получить запрос OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **Проверка `npx` завершается ошибкой `ECOMPROMISED: Lock compromised`**: повторите с чистым кэшем:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Тег нужно перепривязать после позднего исправления**: принудительно обновите и отправьте тег, затем убедитесь, что ассеты релиза GitHub всё ещё соответствуют:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **Релиз GitHub + appcast**

- [ ] Проставьте тег и отправьте: `git tag vX.Y.Z && git push origin vX.Y.Z` (или `git push --tags`).
- [ ] Создайте/обновите релиз GitHub для `vX.Y.Z` с **заголовком `openclaw X.Y.Z`** (а не просто тег); тело должно включать **полный** раздел changelog для этой версии (Highlights + Changes + Fixes), встроенно (без голых ссылок), и **не должно повторять заголовок внутри тела**.
- [ ] Прикрепите артефакты: tarball `npm pack` (необязательно), `OpenClaw-X.Y.Z.zip` и `OpenClaw-X.Y.Z.dSYM.zip` (если сгенерирован).
- [ ] Закоммитьте обновлённый `appcast.xml` и отправьте его (Sparkle читает из main).
- [ ] Из чистого временного каталога (без `package.json`) запустите `npx -y openclaw@X.Y.Z send --help`, чтобы подтвердить, что установка/entrypoints CLI работают.
- [ ] Анонсируйте/поделитесь заметками о релизе.

## Область публикации плагинов (npm)

Мы публикуем только **существующие npm‑плагины** в области `@openclaw/*`. Встроенные
плагины, которых нет в npm, остаются **только в дереве диска** (при этом всё равно поставляются в
`extensions/**`).

Процесс получения списка:

1. `npm search @openclaw --json` и зафиксируйте имена пакетов.
2. Сравните с именами `extensions/*/package.json`.
3. Публикуйте только **пересечение** (уже есть в npm).

Текущий список npm‑плагинов (обновляйте при необходимости):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Заметки о релизе также должны упоминать **новые необязательные встроенные плагины**, которые **по умолчанию отключены** (пример: `tlon`).
