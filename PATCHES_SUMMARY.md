# PATCHES_SUMMARY.md — Mattermost Thread & Reply Fixes (TS Source)

> Applied directly to TypeScript sources in the openclaw-fork repo.  
> Corresponds to 3 patches previously applied to compiled JS bundles in `~/.npm-global/lib/node_modules/openclaw/dist/`.

---

## Patch 1: mattermost-thread-followups

**File:** `extensions/mattermost/src/mattermost/monitor.ts`  
**Corresponding JS bundle:** `channel.runtime-DpBBkY-H.js`  
**Problem:** Бот в Mattermost не мог ответить в треде без @упоминания, даже если он уже участвовал в этом треде.  
**Solution:** Добавлено отслеживание threads, в которых бот уже дал видимый ответ (final/block/tool reply). Повторные сообщения в таких тредах пропускают mention-gate.

### Изменения:

1. **Добавлен `Set<string>` для отслеживания participated threads** (строка ~848):

   ```ts
   const participatedMattermostThreads = new Set<string>();
   ```

2. **Проверка перед mention gate** (строка ~1455):

   ```ts
   const inParticipatedMattermostThread =
     kind !== "direct" && threadRootId && participatedMattermostThreads.has(threadRootId);
   if (inParticipatedMattermostThread && !wasMentioned) {
     logVerboseMessage(
       `mattermost: allowing reply in participated thread without mention thread=${threadRootId}`,
     );
   }
   ```

3. **Передача `wasMentioned || inParticipatedMattermostThread` в mention gate** (строка ~1472):

   ```ts
   wasMentioned: Boolean(wasMentioned || inParticipatedMattermostThread),
   ```

4. **Захват результата turn и запись в Set** (строка ~1937):
   ```ts
   if (turnResult?.dispatched) {
     const dispatch = turnResult.dispatchResult;
     const counts = (dispatch as { counts?: Record<string, number> }).counts ?? {};
     const visibleReplySent =
       (dispatch as { queuedFinal?: boolean }).queuedFinal === true ||
       (counts.final ?? 0) > 0 ||
       (counts.block ?? 0) > 0 ||
       (counts.tool ?? 0) > 0;
     if (kind !== "direct" && effectiveReplyToId && visibleReplySent) {
       participatedMattermostThreads.add(effectiveReplyToId);
       logVerboseMessage(
         `mattermost: tracking participated thread for follow-up replies thread=${effectiveReplyToId}`,
       );
     }
   }
   ```

---

## Patch 2: mattermost-threadid

**File:** `extensions/mattermost/src/channel.ts` (строка ~272)  
**Corresponding JS bundle:** `channel-plugin-runtime-CVaV6_gK.js`  
**Problem:** Mattermost-плагин не использовал `params.threadId` как источник replyToId.  
**Solution:** Добавлен `params.threadId` как первый приоритет в цепочке fallback.

### Изменение:

```diff
- const replyToId =
-   normalizeOptionalString(params.replyToId) ?? normalizeOptionalString(params.replyTo);
+ const replyToId =
+   normalizeOptionalString(params.threadId) ??
+   normalizeOptionalString(params.replyToId) ??
+   normalizeOptionalString(params.replyTo);
```

---

## Patch 3: mattermost-root-id

**File:** `extensions/mattermost/src/mattermost/send.ts` (строка ~510)  
**Corresponding JS bundle:** `slash-state-BN3aTjXe.js`  
**Problem:** При ответе в Mattermost-треде `rootId` передавался как `opts.replyToId`, который мог быть ID reply-поста, а не root-поста треда. Ответы могли попасть не в тот тред.  
**Solution:** Добавлена функция `resolveMattermostReplyRootForPost()`, которая делает GET запрос к Mattermost API для получения `root_id` поста и использует его как `rootId` при создании нового поста.

### Изменения:

1. **Новая helper-функция** (строка ~435):

   ```ts
   async function resolveMattermostReplyRootForPost(
     client: Awaited<ReturnType<typeof createMattermostClient>>,
     replyToId?: string,
   ): Promise<string | undefined> {
     const rootId = normalizeOptionalString(replyToId);
     if (!rootId) return;
     try {
       const post = await client.request<Record<string, unknown>>(
         `/posts/${encodeURIComponent(rootId)}`,
       );
       const parentRoot = normalizeOptionalString(post?.root_id as string | undefined);
       return parentRoot || rootId;
     } catch {
       return rootId;
     }
   }
   ```

2. **Использование в `sendMessageMattermost`** (строка ~522):
   ```diff
   - const post = await createMattermostPost(client, {
   + const replyRootId = await resolveMattermostReplyRootForPost(client, opts.replyToId);
   + const post = await createMattermostPost(client, {
         channelId,
         message,
   -     rootId: opts.replyToId,
   +     rootId: replyRootId,
         fileIds,
         props,
       });
   ```

---

## Верификация

- `pnpm exec tsc --noEmit -p tsconfig.extensions.json` — 0 ошибок
- Все изменения в TypeScript-файлах, код в стиле существующего
- Изменения минимальны — только 3 целевых правки, ничего лишнего
