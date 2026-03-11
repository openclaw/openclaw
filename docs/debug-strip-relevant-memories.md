# 排查与重构记录：Web UI 中 user bubble 显示 `<relevant-memories>` 标签

## 第一部分：Bug 排查

### 问题现象

Web UI 聊天界面中，用户消息气泡显示了 `<relevant-memories>...</relevant-memories>` 标签的原始内容，应该在显示时被自动去除。

### 数据流概览

memory-lancedb 插件通过 `before_prompt_build` 钩子注入记忆上下文：

```
用户发送消息
  → UI 客户端构造 { role: "user", content: "原始文本" }
  → 发送到 gateway
  → agent loop 触发 before_prompt_build hook
  → memory-lancedb 插件返回:
      - prependContext: "<relevant-memories>...</relevant-memories>"
      - 元数据（含 stripRegex）
  → effectivePrompt = prependContext + "\n\n" + 原始 prompt
  → sessionManager.appendMessage() 持久化到 JSONL
  → LLM 回复
  → UI 显示消息
```

UI 显示路径：

```
extractTextCached(message)
  → extractText(message)
    → processMessageText(raw, role, message)
      → 对 user 消息: stripInboundMetadata → strip 插件注入内容
        → 读取消息上的元数据 → new RegExp(stripRegex) → 替换
```

### 排查过程

**第一步：确认 hook 注入是否生效**

服务端日志确认 hook 返回了元数据，且成功注入到持久化 user message 中。

**第二步：确认 UI 侧是否收到元数据**

user message 有两种来源：

| 场景     | 来源                       | 是否含元数据 |
| -------- | -------------------------- | ------------ |
| 实时发送 | 客户端本地构造的消息对象   | 否           |
| 加载历史 | 从 JSONL 读取，经 API 返回 | 是           |

刷新页面后（从历史加载）仍然没 strip，说明不仅是"没收到元数据"的问题。

**第三步：在 UI 侧加调试日志**

在 strip 函数中加 `console.log`，打印 `regex.source`、匹配结果等。浏览器 DevTools 输出：

```
hasCtx: true                    // 元数据确实传到了
matched: false                  // regex 没匹配上！
regexSource: [\\\\s\\\\S]       // 实际编译出的 regex 有问题
```

**第四步：定位根因 — regex 转义层数错误**

插件源码：

```typescript
const MEMORY_TAG_REGEX = `^<${MEMORY_TAG_NAME}[^>]*>[\\\\s\\\\S]*?</${MEMORY_TAG_NAME}>\\\\s*`;
```

问题在于模板字符串的转义层数。逐层分析：

| 源码写法      | 模板字符串求值后  | `new RegExp()` 编译为 | 实际匹配     |
| ------------- | ----------------- | --------------------- | ------------ |
| `\\\\s`       | `\\s`（反斜杠+s） | 转义字面 `s`          | 字面反斜杠+s |
| `\\s`（正确） | `\s`（转义序列）  | `\s`                  | 空白字符     |

`[\\s\\S]` 本意是匹配**任意字符（含换行）**，但多了一层转义后匹配不到换行，自然无法匹配多行的 `<relevant-memories>` 标签。

### 转义层数速查表

```
场景                        写法          JS字符串值    RegExp 含义
──────────────────────────────────────────────────────────────────
模板字符串 → RegExp         `\\s`         \s           空白字符 ✓
普通字符串 → RegExp         "\\s"         \s           空白字符 ✓
JSON → parse → RegExp       "\\\\s"       \\s → \s     空白字符 ✓

错误（多一层）:
模板字符串 → RegExp         `\\\\s`       \\s          字面 \+s ✗
```

### 修复

将 `\\\\s` 改为 `\\s`：

```diff
- const MEMORY_TAG_REGEX = `^<${MEMORY_TAG_NAME}[^>]*>[\\\\s\\\\S]*?</${MEMORY_TAG_NAME}>\\\\s*`;
+ const MEMORY_TAG_REGEX = `^<${MEMORY_TAG_NAME}[^>]*>[\\s\\S]*?</${MEMORY_TAG_NAME}>\\s*`;
```

---

## 第二部分：架构重构

### 问题：hook 中的特化字段

修复 bug 后，hook 系统中的代码长这样：

```typescript
// src/plugins/types.ts — hook 结果类型
export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  lancedbPluginMemoryContext?: {
    // ← 为一个插件专门加的字段
    prependTag: string;
    stripRegex: string;
  };
  prependSystemContext?: string;
  appendSystemContext?: string;
};
```

`lancedbPluginMemoryContext` 这个字段名直接写死在 `types.ts`、`hooks.ts`、`attempt.ts` 三个**核心文件**里。hook 是公共基础设施，为某一个插件加专用字段有以下问题：

1. **违反开闭原则** — 每新增一个需要类似功能的插件，都要改核心类型定义
2. **命名耦合** — 核心代码认识了 `lancedb` 这个插件名
3. **合并逻辑不可扩展** — `hooks.ts` 里需要为每个新字段写特定的合并策略

### 思考：需求的本质是什么

退一步想，插件向 user message 注入内容后，需要：

1. 把某些**元数据**附加到持久化消息上（这样 UI 加载历史时能拿到）
2. UI 根据元数据决定**如何 strip 注入的内容**

这两个需求都是通用的，不应该跟具体插件名绑定。

### 方案对比

#### 方案 A：通用 `messageMeta` 透传袋

hook 结果提供一个 `Record<string, unknown>` 类型的 bag，任何插件都可以往里放东西：

```typescript
messageMeta?: Record<string, unknown>;
```

- 核心只负责 shallow merge 和透传
- 插件自己定义 key 名（如 `lancedbContext`、`myPluginData`）
- UI 按需读取特定 key

**优点：** 一次改动，永久扩展。**缺点：** UI 仍需认识具体 key。

#### 方案 B：标准 `displayStripPatterns` 协议

如果核心需求就是"strip 注入的文本"，直接抽象这个动作：

```typescript
displayStripPatterns?: Array<{ regex: string; flags?: string }>;
```

UI 侧完全通用 — 遍历数组，逐个执行 regex replace：

```typescript
for (const p of patterns) {
  result = result.replace(new RegExp(p.regex, p.flags ?? "i"), "").trim();
}
```

**优点：** UI 完全解耦。**缺点：** 只解决 strip 场景，不覆盖其他元数据需求。

#### 方案 C：`prependContext` 自带 strip 声明

把 strip 信息跟 `prependContext` 绑定，改为结构化：

```typescript
prependContext?: string | { text: string; stripFromDisplay?: string };
```

**优点：** 自然关联。**缺点：** 破坏已有 API，改动面大。

### 最终方案：A + B 结合

取两者优点：

1. **`messageMeta: Record<string, unknown>`** — 通用透传袋，任何插件元数据都走这里
2. **`displayStripPatterns`** — 作为 `messageMeta` 中的一个**约定标准 key**

这样设计的分层：

```
┌──────────────────────────────────────────────────┐
│  Plugin (memory-lancedb)                         │
│  返回 messageMeta: {                             │
│    displayStripPatterns: [{ regex: "..." }]       │
│  }                                               │
├──────────────────────────────────────────────────┤
│  Core Hook System (hooks.ts / attempt.ts)        │
│  只知道 messageMeta — shallow merge + 注入消息    │
│  不知道任何具体 key 的含义                         │
├──────────────────────────────────────────────────┤
│  UI (message-extract.ts)                         │
│  只知道 displayStripPatterns — 遍历执行 regex     │
│  不知道是哪个插件产生的                            │
└──────────────────────────────────────────────────┘
```

每一层只认识自己该认识的东西，没有跨层耦合。

### 重构实施

#### 1. `src/plugins/types.ts` — 类型定义

```diff
  export type PluginHookBeforePromptBuildResult = {
    systemPrompt?: string;
    prependContext?: string;
-   lancedbPluginMemoryContext?: {
-     prependTag: string;
-     stripRegex: string;
-   };
+   /**
+    * Generic key-value bag for plugins to attach metadata to the persisted
+    * user message. Standard key: displayStripPatterns.
+    */
+   messageMeta?: Record<string, unknown>;
    prependSystemContext?: string;
    appendSystemContext?: string;
  };

  export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
    "systemPrompt",
    "prependContext",
-   "lancedbPluginMemoryContext",
+   "messageMeta",
    "prependSystemContext",
    "appendSystemContext",
  ] as const;
```

#### 2. `src/plugins/hooks.ts` — 合并逻辑

```diff
- lancedbPluginMemoryContext: next.lancedbPluginMemoryContext ?? acc?.lancedbPluginMemoryContext,
+ messageMeta: { ...acc?.messageMeta, ...next.messageMeta },
```

用 shallow merge 而非 last-wins，因为不同插件可能放不同的 key，应该都保留。后声明的插件的同名 key 会覆盖前面的（符合 hook 优先级语义）。

#### 3. `src/agents/pi-embedded-runner/run/attempt.ts` — 注入逻辑

```diff
- let pendingPluginMemoryContext: { prependTag: string; stripRegex: string } | undefined;
+ let pendingMessageMeta: Record<string, unknown> | undefined;

  sessionManager.appendMessage = ((msg: unknown) => {
    const message = msg as Record<string, unknown>;
-   if (pendingPluginMemoryContext && message.role === "user") {
-     message.lancedbPluginMemoryContext = pendingPluginMemoryContext;
-     pendingPluginMemoryContext = undefined;
+   if (pendingMessageMeta && message.role === "user") {
+     Object.assign(message, pendingMessageMeta);
+     pendingMessageMeta = undefined;
    }
    return innerAppend(msg);
  });
```

`Object.assign` 把 `messageMeta` 的所有 key-value 平铺到消息对象上。这样消息 JSONL 中会有：

```json
{
  "role": "user",
  "content": "...",
  "displayStripPatterns": [{ "regex": "..." }]
}
```

#### 4. `ui/src/ui/chat/message-extract.ts` — UI strip 逻辑

```diff
- interface PluginMemoryContext {
-   prependTag: string;
-   stripRegex: string;
- }
+ interface DisplayStripPattern {
+   regex: string;
+   flags?: string;
+ }

- function stripPluginMemoryContext(text, message) {
-   const ctx = message.lancedbPluginMemoryContext;
-   if (ctx?.stripRegex) {
-     const regex = new RegExp(ctx.stripRegex, "i");
-     result = result.replace(regex, "").trim();
-   }
- }
+ function stripDisplayPatterns(text, message) {
+   const patterns = message.displayStripPatterns as DisplayStripPattern[];
+   if (!Array.isArray(patterns) || patterns.length === 0) return text;
+   let result = text;
+   for (const p of patterns) {
+     try {
+       result = result.replace(new RegExp(p.regex, p.flags ?? "i"), "").trim();
+     } catch { /* skip invalid regex */ }
+   }
+   return result;
+ }
```

完全不知道 `lancedb` 的存在。任何插件只要在消息上放了 `displayStripPatterns`，UI 都会处理。

#### 5. `extensions/memory-lancedb/index.ts` — 插件适配

```diff
  return {
    prependContext: formatRelevantMemoriesContext(...),
-   lancedbPluginMemoryContext: {
-     prependTag: MEMORY_TAG_NAME,
-     stripRegex: MEMORY_TAG_REGEX,
-   },
+   messageMeta: {
+     displayStripPatterns: [{ regex: MEMORY_TAG_REGEX }],
+   },
  };
```

插件通过标准协议声明 strip 需求，不再需要核心代码为它开后门。

### 扩展性验证

假设未来有一个 `context-inject` 插件也往 user message 注入了 `<context>` 标签，它只需要：

```typescript
return {
  prependContext: "<context>...</context>",
  messageMeta: {
    displayStripPatterns: [{ regex: "^<context>[\\s\\S]*?</context>\\s*" }],
  },
};
```

核心代码 **零改动**。UI 自动 strip。这就是通用设计的价值。

### 改动文件总结

| 文件                                 | 角色 | 改动                                         |
| ------------------------------------ | ---- | -------------------------------------------- |
| `src/plugins/types.ts`               | 类型 | `lancedbPluginMemoryContext` → `messageMeta` |
| `src/plugins/hooks.ts`               | 合并 | last-wins → shallow merge                    |
| `src/agents/.../attempt.ts`          | 注入 | 专用字段 → `Object.assign` 通用注入          |
| `ui/.../message-extract.ts`          | 显示 | 专用 strip → 遍历 `displayStripPatterns[]`   |
| `extensions/memory-lancedb/index.ts` | 插件 | 使用标准 `messageMeta.displayStripPatterns`  |

### 设计原则回顾

1. **核心无感知** — hook 系统只做透传和 merge，不认识任何插件
2. **协议驱动** — `displayStripPatterns` 是一个约定，不是硬编码
3. **开闭原则** — 新插件加 strip 需求不需要改核心
4. **渐进式** — `messageMeta` 是通用 bag，未来可以约定更多标准 key（如 `displayBadge`、`messageAnnotation` 等）
