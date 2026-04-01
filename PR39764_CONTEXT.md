# PR #39764 — PathGuard (контекст, стан, план)

> Repo: `C:\Users\Svitlana\.openclaw\workspace\openclaw`
> 
> PR: https://github.com/openclaw/openclaw/pull/39764
> 
> Мета цього файлу: якщо відкрити **лише його**, одразу зрозуміти що за PR, який стан, що вже виправлено, що ще треба зробити, і які ризики/пріоритети.

---

## 0) TL;DR

- PR додає **PathGuard**: політика `workspaceOnly + allowedPaths + denyPaths` з підтримкою glob’ів та захистом від symlink-escape.
- Інтеграція зроблена в tool-обгортки (read/write/edit + image/pdf), плюс тестове покриття.
- Виправлено всі **P1/P2 parse- та lint-ошибки**, які репортили боти:
  - duplicate `getMediaUnderstandingProvider` (image-tool)
  - duplicate `loadWebMediaRaw` (pdf-tool)
  - duplicate `getDefaultLocalRoots` + duplicate param `options` (media-tool-shared)
  - синтаксична помилка в `ui/storage.node.test.ts` (не закритий object literal)
- Поточний стан локально: `pnpm lint` = OK; `pnpm test -- src/security/path-guard.test.ts` = OK.
- Далі найближча задача: **перевірка build/CI без інсталяцій** (де можливо) + чистка конфліктів; потім — глибокий безпековий прохід (exec/spawn bypass).

---

## 1) Про що PR (функціональний опис)

### 1.1. Що таке PathGuard
`PathGuard` — модуль, який перевіряє доступ до файлових шляхів відповідно до політики:

- `workspaceOnly?: boolean` — якщо true, доступ дозволений лише в межах workspace root.
- `allowedPaths?: string[]` — allowlist (може містити абсолютні шляхи або workspace-relative патерни).
- `denyPaths?: string[]` — denylist (має пріоритет над allow).

Підтримка:
- glob’и через `minimatch` (brace/extglob, пробіли, нормалізація шляхів)
- захист від обходів через symlink’и
- коректна поведінка для неіснуючих файлів (ENOENT): резолвиться найближчий існуючий parent, щоб не дозволити “створити файл пізніше за межами workspace через symlink”.

### 1.2. Ключова семантика
- **deny overrides allow**
- relative entries повинні бути **workspace-anchored**

---

## 2) Де в коді основні зміни

### 2.1. Нові файли
- `src/security/path-guard.ts`
- `src/security/path-guard.test.ts`

### 2.2. Інтеграція у tooling
- `src/agents/pi-tools.read.ts`
  - `wrapToolWorkspaceRootGuardWithOptions(...)` тепер може викликати `checkPathGuardStrict(...)`, якщо передано `policy`.
- `src/agents/pi-tools.ts`
  - збирання `ToolFsPolicy` через `createToolFsPolicy({ workspaceOnly, allowedPaths, denyPaths })`
  - логіка `shouldWrapFsTools` (вмикати wrap не лише при workspaceOnly, а й якщо є allow/deny)

### 2.3. Media tools
- `src/agents/tools/image-tool.ts` + `image-tool.test.ts`
- `src/agents/tools/pdf-tool.ts` + `pdf-tool.test.ts`
- `src/agents/tools/media-tool-shared.ts`

У media-tools важливо:
- корені (local roots) — лише частина захисту
- потрібен **per-file enforcement** PathGuard для кожного реально відкриваного файла

---

## 3) Важливий стан гілок / checkout

### 3.1. Локальний checkout PR
У цій машині GitHub CLI `gh` відсутній, тому PR checkout робиться вручну:

```bash
cd C:\Users\Svitlana\.openclaw\workspace\openclaw

git fetch origin pull/39764/head:pr/39764
git checkout pr/39764
```

Поточний HEAD (на момент створення цього файлу):
- branch: `pr/39764`

### 3.2. Гілка автора (fork)
Remote `fork` → `https://github.com/Ar3ss12/openclaw.git`

Є авторська гілка:
- `fork/feature/pathguard-39672`

---

## 4) Що вже виправлено (конкретні баги)

> Нижче — фактичні фікси, які робились під час роботи з PR.

### 4.1. `media-tool-shared.ts`: дубль імпорту + неправильний шлях
Було (приклад проблемного стану):
- дубль `getDefaultLocalRoots` з двох модулів
- один з модулів мав шлях, якого нема в репо (типу `../../web/media.js`)

Симптоми:
- build/test падає з `Identifier getDefaultLocalRoots has already been declared`
- або `Cannot find module '../../web/media.js'`

Виправлення (правильний варіант):
- лишити **один** імпорт:
  - `import { getDefaultLocalRoots } from "../../plugin-sdk/web-media.js";`

### 4.2. `pi-tools.ts`: дубль ключа `workspaceOnly`
Було:
```ts
const fsPolicy = createToolFsPolicy({
  workspaceOnly: fsConfig.workspaceOnly,
  ...
  workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly,
});
```

Це JS-логічно працює (другий ключ перезаписує перший), але:
- це помилка читабельності
- eslint `no-dupe-keys` валить CI

Виправлення:
- залишити один ключ:
```ts
workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly
```

### 4.3. `pi-tools.ts`: unused import
- `wrapToolWorkspaceRootGuard` був імпортований, але не використовувався → прибрано

### 4.4. Коміт з фіксами
Внесено коміт (у fork-гілку автора):
- commit: `2d9a519b0f`
- message: `fix pathguard follow-ups and cleanup`

> Якщо PR-ветка `pr/39764` не містить цей коміт, його треба перенести (через cherry-pick або оновлення PR-гілки).

---

## 5) Що зараз ламається / типові фейли (з попередніх прогонів)

> Це список, щоб швидко зрозуміти, які помилки “реальні” (код/логіка), а які “оточення” (Windows/symlink/Playwright).

### 5.1. Реальні кодові фейли
- дубль/невірний імпорт `getDefaultLocalRoots` → compile error
- дубль ключа `workspaceOnly` → eslint error

### 5.2. Оточення / не-блокери (можуть бути у локальному Windows)
- EPERM на symlink у тестах (Windows без dev mode/прав)
- audit/test що викликають `icacls` з grant → потребує прав
- UI browser tests через Playwright без встановлених браузерів (`pnpm exec playwright install`) — це установка (зараз “без встановлення” — пропускаємо)

---

## 6) Поточний план робіт (пріоритети)

### Phase A — “прибрати помилки, які скажуть боти/перевірка”, без встановлень
1) Переконатися, що PR-ветка містить фікси з п.4.
2) Пройти `pnpm lint` (не потребує install, якщо deps вже є локально).
3) Пройти релевантні unit тести (PathGuard + image/pdf), не торкаючись тестів що потребують Playwright/symlink.
4) При потребі — мінімальні стабілізації тестів, але **без змін логіки** (тільки deterministic mocks/fixtures).

### Phase B — глибокий прохід безпеки (після стабілізації)
1) `exec` bypass: PathGuard не є boundary, якщо exec може читати/копіювати будь-що.
   - мінімальний крок: enforce `workdir` у межах policy/workspace.
2) spawned агенти (Codex/Claude) workdir validation.
3) perf: кеш realpath/matchers.

---

## 7) Питання, які треба тримати в голові (щоб не зламати семантику)

1) **Що саме є workspaceRoot** в різних режимах:
   - host workspace
   - sandbox workspace
   - containerWorkdir mapping

2) Glob policy:
   - relative patterns мають матчити по `path.relative(workspaceRoot, realPath)`
   - не повинні матчити якщо path поза workspace

3) Deny precedence:
   - deny має блокувати навіть якщо allow також матчить

4) Media roots vs per-file enforcement:
   - корені — це оптимізація/перший фільтр
   - без `checkPathGuardStrict` на кожен реальний файл — можуть бути обходи

---

## 8) Що мені потрібно знати від автора/рев’ю (мінімум)

1) Чи PR має включати **тільки PathGuard**, чи сторонні фікси (discord/telegram/slack/ci) допускаються?
2) Який мінімальний CI-гейт для merge: lint + unit? чи ще e2e/ui?
3) Чи вважаємо `exec`/spawn bypass **блокером** (P0), чи follow-up (P1/P2)?

---

## 9) Команди-шпаргалка (без встановлення)

```bash
# Перейти на PR
cd C:\Users\Svitlana\.openclaw\workspace\openclaw

git fetch origin pull/39764/head:pr/39764
git checkout pr/39764

# Подивитись що в PR відносно main
git diff --stat origin/main...HEAD

# Лінт
pnpm lint

# Вибіркові тести (low-risk)
pnpm test -- src/security/path-guard.test.ts
```

---

## 10) Поточний “Next action”

- Перевірити, чи `pr/39764` уже містить коміт `2d9a519b0f`.
  - Якщо ні: запропонувати cherry-pick у PR-ветку / оновити PR-ветку на fork.
- Запустити мінімальний lint + targeted unit (без Playwright install).

