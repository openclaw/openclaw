# Kilo Gateway 提供者整合設計

## 概述

本文件概述了將「Kilo Gateway」作為 OpenClaw 的一級提供者進行整合的設計，該設計參考了現有的 OpenRouter 實作。Kilo Gateway 使用與 OpenAI 兼容的 completions API，但其基本 URL 不同。

## 設計決策

### 1. 提供者命名

**建議: `kilocode`**

[[BLOCK_1]]

- 符合提供的用戶設定範例 (`kilocode` 提供者金鑰)
- 與現有的提供者命名模式一致 (例如，`openrouter`, `opencode`, `moonshot`)
- 簡短且易於記憶
- 避免與一般的「kilo」或「gateway」術語混淆

考慮的替代方案：`kilo-gateway` - 被拒絕因為在程式碼庫中，帶有連字符的名稱較不常見，而 `kilocode` 更為簡潔。

### 2. 預設模型參考

**建議: `kilocode/anthropic/claude-opus-4.6`**

[[BLOCK_1]]

- 根據使用者設定範例
- Claude Opus 4.5 是一個功能強大的預設模型
- 明確的模型選擇避免依賴自動路由

### 3. 基本 URL 設定

**建議：硬編碼預設值並允許設定覆蓋**

- **預設基本 URL:** `https://api.kilo.ai/api/gateway/`
- **可設定:** 是，透過 `models.providers.kilocode.baseUrl`

這與其他提供者如 Moonshot、Venice 和 Synthetic 使用的模式相符。

### 4. 模型掃描

**建議：最初不設置專用的模型掃描端點**

Rationale:

- Kilo Gateway 代理到 OpenRouter，因此模型是動態的
- 使用者可以在其設定中手動設定模型
- 如果 Kilo Gateway 在未來公開 `/models` 端點，可以添加掃描功能

### 5. 特殊處理

**建議：為 Anthropic 模型繼承 OpenRouter 行為**

由於 Kilo Gateway 代理到 OpenRouter，因此應該適用相同的特殊處理：

- `anthropic/*` 模型的快取 TTL 資格
- `anthropic/*` 模型的額外參數 (cacheControlTtl)
- 逐字稿政策遵循 OpenRouter 模式

## Files to Modify

### 核心憑證管理

`src/commands/onboard-auth.credentials.ts`

[[BLOCK_1]]

typescript
export const KILOCODE_DEFAULT_MODEL_REF = "kilocode/anthropic/claude-opus-4.6";

typescript
export async function setKilocodeApiKey(key: string, agentDir?: string) {
upsertAuthProfile({
profileId: "kilocode:default",
credential: {
type: "api_key",
provider: "kilocode",
key,
},
agentDir: resolveAuthAgentDir(agentDir),
});
}

#### 2. `src/agents/model-auth.ts`

Add to `envMap` in `resolveEnvApiKey()`:

```typescript
const envMap: Record<string, string> = {
  // ... existing entries
  kilocode: "KILOCODE_API_KEY",
};
```

#### 3. `src/config/io.ts`

`SHELL_ENV_EXPECTED_KEYS`

```typescript
const SHELL_ENV_EXPECTED_KEYS = [
  // ... existing entries
  "KILOCODE_API_KEY",
];
```

### Config Application

#### 4. `src/commands/onboard-auth.config-core.ts`

新增功能：

typescript
export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";

typescript
export function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
const models = { ...cfg.agents?.defaults?.models };
models[KILOCODE_DEFAULT_MODEL_REF] = {
...models[KILOCODE_DEFAULT_MODEL_REF],
alias: models[KILOCODE_DEFAULT_MODEL_REF]?.alias ?? "Kilo Gateway",
};

javascript
const providers = { ...cfg.models?.providers };
const existingProvider = providers.kilocode;
const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
string,
unknown

> as { apiKey?: string };
> const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
> const normalizedApiKey = resolvedApiKey?.trim();

providers.kilocode = {
...existingProviderRest,
baseUrl: KILOCODE_BASE_URL,
api: "openai-completions",
...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
};

javascript
return {
...cfg,
agents: {
...cfg.agents,
defaults: {
...cfg.agents?.defaults,
models,
},
},
models: {
mode: cfg.models?.mode ?? "merge",
providers,
},
};
}

typescript
export function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig {
const next = applyKilocodeProviderConfig(cfg);
const existingModel = next.agents?.defaults?.model;
return {
...next,
agents: {
...next.agents,
defaults: {
...next.agents?.defaults,
model: {
...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
? {
fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
}
: undefined),
primary: KILOCODE_DEFAULT_MODEL_REF,
},
},
},
};
}

### Auth Choice System

#### 5. `src/commands/onboard-types.ts`

Add to `AuthChoice` type:

```typescript
export type AuthChoice =
  // ... existing choices
  "kilocode-api-key";
// ...
```

`OnboardOptions`

```typescript
export type OnboardOptions = {
  // ... existing options
  kilocodeApiKey?: string;
  // ...
};
```

#### 6. `src/commands/auth-choice-options.ts`

`AuthChoiceGroupId`

```typescript
export type AuthChoiceGroupId =
  // ... existing groups
  "kilocode";
// ...
```

`AUTH_CHOICE_GROUP_DEFS`

```typescript
{
  value: "kilocode",
  label: "Kilo Gateway",
  hint: "API key (OpenRouter-compatible)",
  choices: ["kilocode-api-key"],
},
```

`buildAuthChoiceOptions()`

```typescript
options.push({
  value: "kilocode-api-key",
  label: "Kilo Gateway API key",
  hint: "OpenRouter-compatible gateway",
});
```

#### 7. `src/commands/auth-choice.preferred-provider.ts`

[[BLOCK_N]]  
添加映射：  
[[BLOCK_N]]

```typescript
const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  // ... existing mappings
  "kilocode-api-key": "kilocode",
};
```

### Auth Choice Application

#### 8. `src/commands/auth-choice.apply.api-providers.ts`

Add import:

```typescript
import {
  // ... existing imports
  applyKilocodeConfig,
  applyKilocodeProviderConfig,
  KILOCODE_DEFAULT_MODEL_REF,
  setKilocodeApiKey,
} from "./onboard-auth.js";
```

新增對 `kilocode-api-key` 的處理：

typescript
if (authChoice === "kilocode-api-key") {
const store = ensureAuthProfileStore(params.agentDir, {
allowKeychainPrompt: false,
});
const profileOrder = resolveAuthProfileOrder({
cfg: nextConfig,
store,
provider: "kilocode",
});
const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
let profileId = "kilocode:default";
let mode: "api_key" | "oauth" | "token" = "api_key";
let hasCredential = false;

如果 (existingProfileId && existingCred?.type) {
profileId = existingProfileId;
mode =
existingCred.type === "oauth" ? "oauth" : existingCred.type === "token" ? "token" : "api_key";
hasCredential = true;
}

如果 (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "kilocode") {
await setKilocodeApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
hasCredential = true;
}

如果 (!hasCredential) {
const envKey = resolveEnvApiKey("kilocode");
if (envKey) {
const useExisting = await params.prompter.confirm({
message: `Use existing KILOCODE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
initialValue: true,
});
if (useExisting) {
await setKilocodeApiKey(envKey.apiKey, params.agentDir);
hasCredential = true;
}
}
}

如果 (!hasCredential) {
const key = await params.prompter.text({
message: "請輸入 Kilo Gateway API 金鑰",
validate: validateApiKeyInput,
});
await setKilocodeApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
hasCredential = true;
}

javascript
if (hasCredential) {
nextConfig = applyAuthProfileConfig(nextConfig, {
profileId,
provider: "kilocode",
mode,
});
}
{
const applied = await applyDefaultModelChoice({
config: nextConfig,
setDefaultModel: params.setDefaultModel,
defaultModel: KILOCODE_DEFAULT_MODEL_REF,
applyDefaultConfig: applyKilocodeConfig,
applyProviderConfig: applyKilocodeProviderConfig,
noteDefault: KILOCODE_DEFAULT_MODEL_REF,
noteAgentModel,
prompter: params.prompter,
});
nextConfig = applied.config;
agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
}
return { config: nextConfig, agentModelOverride };
}

也請在函數的最上方添加 tokenProvider 映射：

```typescript
if (params.opts.tokenProvider === "kilocode") {
  authChoice = "kilocode-api-key";
}
```

### CLI 註冊

#### 9. `src/cli/program/register.onboard.ts`

新增 CLI 選項：

```typescript
.option("--kilocode-api-key <key>", "Kilo Gateway API key")
```

新增至動作處理器：

```typescript
kilocodeApiKey: opts.kilocodeApiKey as string | undefined,
```

[[BLOCK_1]]  
更新 auth-choice 幫助文字：  
[[INLINE_1]]

```typescript
.option(
  "--auth-choice <choice>",
  "Auth: setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|kilocode-api-key|ai-gateway-api-key|...",
)
```

### 非互動式入門指南

#### 10. `src/commands/onboard-non-interactive/local/auth-choice.ts`

添加對 `kilocode-api-key` 的處理：

```typescript
if (authChoice === "kilocode-api-key") {
  const resolved = await resolveNonInteractiveApiKey({
    provider: "kilocode",
    cfg: baseConfig,
    flagValue: opts.kilocodeApiKey,
    flagName: "--kilocode-api-key",
    envVar: "KILOCODE_API_KEY",
  });
  await setKilocodeApiKey(resolved.apiKey, agentDir);
  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "kilocode:default",
    provider: "kilocode",
    mode: "api_key",
  });
  // ... apply default model
}
```

### Export Updates

#### 11. `src/commands/onboard-auth.ts`

新增匯出：

typescript
export {
// ... 現有的匯出
applyKilocodeConfig,
applyKilocodeProviderConfig,
KILOCODE_BASE_URL,
} from "./onboard-auth.config-core.js";

javascript
export {
// ... 現有的匯出
KILOCODE_DEFAULT_MODEL_REF,
setKilocodeApiKey,
} from "./onboard-auth.credentials.js";

### 特殊處理 (選用)

#### 12. `src/agents/pi-embedded-runner/cache-ttl.ts`

新增 Kilo Gateway 支援 Anthropic 模型：

```typescript
export function isCacheTtlEligibleProvider(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedProvider === "anthropic") return true;
  if (normalizedProvider === "openrouter" && normalizedModelId.startsWith("anthropic/"))
    return true;
  if (normalizedProvider === "kilocode" && normalizedModelId.startsWith("anthropic/")) return true;
  return false;
}
```

#### 13. `src/agents/transcript-policy.ts`

新增 Kilo Gateway 處理（類似於 OpenRouter）：

typescript
const isKilocodeGemini = provider === "kilocode" && modelId.toLowerCase().includes("gemini");

// Include in needsNonImageSanitize check
const needsNonImageSanitize =
isGoogle || isAnthropic || isMistral || isOpenRouterGemini || isKilocodeGemini;

## 設定結構

### User Config Example

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "kilocode": {
        "baseUrl": "https://api.kilo.ai/api/gateway/",
        "apiKey": "xxxxx",
        "api": "openai-completions",
        "models": [
          {
            "id": "anthropic/claude-opus-4.6",
            "name": "Anthropic: Claude Opus 4.6"
          },
          { "id": "minimax/minimax-m2.5:free", "name": "Minimax: Minimax M2.5" }
        ]
      }
    }
  }
}
```

### Auth Profile 結構

```json
{
  "profiles": {
    "kilocode:default": {
      "type": "api_key",
      "provider": "kilocode",
      "key": "xxxxx"
    }
  }
}
```

## 測試考量

1. **單元測試：**
   - 測試 `setKilocodeApiKey()` 是否寫入正確的設定檔
   - 測試 `applyKilocodeConfig()` 是否設置正確的預設值
   - 測試 `resolveEnvApiKey("kilocode")` 是否返回正確的環境變數

2. **整合測試：**
   - 測試入門流程與 `--auth-choice kilocode-api-key`
   - 測試非互動式入門與 `--kilocode-api-key`
   - 測試模型選擇與 `kilocode/` 前綴

3. **E2E 測試：**
   - 通過 Kilo Gateway 測試實際的 API 呼叫（實時測試）

## Migration Notes

- 現有用戶無需進行遷移
- 新用戶可以立即使用 `kilocode-api-key` 認證選擇
- 現有的手動設定與 `kilocode` 提供者將繼續運作

## 未來考量

1. **模型目錄：** 如果 Kilo Gateway 暴露 `/models` 端點，請添加類似 `scanOpenRouterModels()` 的掃描支援。

2. **OAuth 支援：** 如果 Kilo Gateway 增加 OAuth，請相應地擴充認證系統。

3. **速率限制：** 考慮在必要時為 Kilo Gateway 添加特定的速率限制處理。

4. **文件：** 在 `docs/providers/kilocode.md` 添加說明設置和使用的文檔。

## 變更摘要

| 檔案                                                        | 變更類型 | 描述                                                                      |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `src/commands/onboard-auth.credentials.ts`                  | 新增     | `KILOCODE_DEFAULT_MODEL_REF`, `setKilocodeApiKey()`                       |
| `src/agents/model-auth.ts`                                  | 修改     | 將 `kilocode` 新增至 `envMap`                                             |
| `src/config/io.ts`                                          | 修改     | 將 `KILOCODE_API_KEY` 新增至 shell 環境變數                               |
| `src/commands/onboard-auth.config-core.ts`                  | 新增     | `applyKilocodeProviderConfig()`, `applyKilocodeConfig()`                  |
| `src/commands/onboard-types.ts`                             | 修改     | 將 `kilocode-api-key` 新增至 `AuthChoice`，將 `kilocodeApiKey` 新增至選項 |
| `src/commands/auth-choice-options.ts`                       | 修改     | 新增 `kilocode` 群組和選項                                                |
| `src/commands/auth-choice.preferred-provider.ts`            | 修改     | 新增 `kilocode-api-key` 對應                                              |
| `src/commands/auth-choice.apply.api-providers.ts`           | 修改     | 新增 `kilocode-api-key` 處理                                              |
| `src/cli/program/register.onboard.ts`                       | 修改     | 新增 `--kilocode-api-key` 選項                                            |
| `src/commands/onboard-non-interactive/local/auth-choice.ts` | 修改     | 新增非互動式處理                                                          |
| `src/commands/onboard-auth.ts`                              | 修改     | 匯出新函數                                                                |
| `src/agents/pi-embedded-runner/cache-ttl.ts`                | 修改     | 新增 kilocode 支援                                                        |
| `src/agents/transcript-policy.ts`                           | 修改     | 新增 kilocode Gemini 處理                                                 |
