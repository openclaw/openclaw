# Issue #34312 修复总结

## 问题描述

Gemini native PDF URL 重复 (`/v1beta/v1beta`) 导致 404 错误。

## 根因分析

代码库中不同模块对 Gemini baseUrl 的处理方式不一致：

- `pdf-native-providers.ts`: 默认 baseUrl 不含 `/v1beta`，总是追加
- `media-understanding/inline-data.ts`: 默认 baseUrl 包含 `/v1beta`，不追加
- `embeddings-gemini.ts`: 默认 baseUrl 包含 `/v1beta`，不追加

当用户配置的 baseUrl 已经包含 `/v1beta` 时，某些模块会再次追加，导致 `/v1beta/v1beta` 重复。

## 修复方案

### 1. 创建统一的 URL 构建工具

**文件：** `src/utils/gemini-url.ts`

新增 `buildGeminiUrl()` 函数，特点：

- 自动检测 baseUrl 是否已包含 `/v1beta`
- 只在需要时追加 `/v1beta`
- 支持可选的 `modelHasPrefix` 参数（处理已包含 `models/` 前缀的情况）
- 统一处理 URL 编码和 API key 参数

### 2. 更新相关模块

#### `src/agents/tools/pdf-native-providers.ts`

- 导入并使用 `buildGeminiUrl()`
- 移除重复的 URL 构建逻辑

#### `src/media-understanding/providers/google/inline-data.ts`

- 导入并使用 `buildGeminiUrl()`
- 移除重复的 URL 构建逻辑

#### `src/memory/embeddings-gemini.ts`

- 导入并使用 `buildGeminiUrl()`
- 使用 `modelHasPrefix: true` 因为 `modelPath` 已包含 `models/` 前缀
- 移除 debug 日志中的冗余 URL（避免混淆）

### 3. 添加测试用例

**文件：** `src/utils/gemini-url.test.ts`

测试覆盖：

- baseUrl 已包含 `/v1beta` 的情况（不重复）
- baseUrl 不包含 `/v1beta` 的情况（自动追加）
- 带尾随斜杠的 baseUrl
- modelId 编码
- API key 编码
- 不同 endpoint 类型（`:generateContent`, `:embedContent`, `:batchEmbedContents`）
- `modelHasPrefix` 参数

## 验证要点

修复后，以下情况都应正常工作：

```typescript
// 情况 1: 默认官方 API
buildGeminiUrl({
  modelId: "gemini-3-pro",
  endpoint: ":generateContent",
});
// 结果: https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent

// 情况 2: 自定义 baseUrl 不含 /v1beta
buildGeminiUrl({
  baseUrl: "https://my-proxy.com",
  modelId: "gemini-3-pro",
  endpoint: ":generateContent",
});
// 结果: https://my-proxy.com/v1beta/models/gemini-3-pro:generateContent

// 情况 3: 自定义 baseUrl 已含 /v1beta (修复前会重复!)
buildGeminiUrl({
  baseUrl: "https://my-proxy.com/v1beta",
  modelId: "gemini-3-pro",
  endpoint: ":generateContent",
});
// 结果: https://my-proxy.com/v1beta/models/gemini-3-pro:generateContent (正确!)
// 修复前可能是: https://my-proxy.com/v1beta/v1beta/models/gemini-3-pro:generateContent (错误!)
```

## 受影响模块

- PDF 分析工具 (`geminiAnalyzePdf`)
- 媒体理解（视频、音频分析）
- Embeddings 生成

## 向后兼容性

✅ 完全向后兼容，所有现有代码无需修改即可继续工作。
