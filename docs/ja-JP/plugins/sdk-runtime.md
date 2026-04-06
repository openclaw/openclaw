---
read_when:
    - プラグインからコアヘルパーを呼び出す必要がある場合（TTS、STT、画像生成、ウェブ検索、サブエージェント）
    - api.runtimeが公開する内容を理解したい場合
    - プラグインコードから設定、エージェント、またはメディアヘルパーにアクセスしている場合
sidebarTitle: Runtime Helpers
summary: api.runtime -- プラグインに注入されるランタイムヘルパー
title: プラグインランタイムヘルパー
x-i18n:
    generated_at: "2026-04-02T07:50:28Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6314eae4285ea2d0e143df447fbe56d6ff93ca2615de47cbf87a7994a191981c
    source_path: plugins/sdk-runtime.md
    workflow: 15
---

# プラグインランタイムヘルパー

プラグインの登録時に注入される`api.runtime`オブジェクトのリファレンスです。ホストの内部モジュールを直接インポートする代わりに、これらのヘルパーを使用してください。

<Tip>
  **ウォークスルーをお探しですか？** これらのヘルパーをコンテキスト内で使用するステップバイステップガイドについては、[チャネルプラグイン](/plugins/sdk-channel-plugins)または[プロバイダープラグイン](/plugins/sdk-provider-plugins)を参照してください。
</Tip>

```typescript
register(api) {
  const runtime = api.runtime;
}
```

## ランタイム名前空間

### `api.runtime.agent`

エージェントのID、ディレクトリ、およびセッション管理。

```typescript
// Resolve the agent's working directory
const agentDir = api.runtime.agent.resolveAgentDir(cfg);

// Resolve agent workspace
const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg);

// Get agent identity
const identity = api.runtime.agent.resolveAgentIdentity(cfg);

// Get default thinking level
const thinking = api.runtime.agent.resolveThinkingDefault(cfg, provider, model);

// Get agent timeout
const timeoutMs = api.runtime.agent.resolveAgentTimeoutMs(cfg);

// Ensure workspace exists
await api.runtime.agent.ensureAgentWorkspace(cfg);

// Run an embedded Pi agent
const agentDir = api.runtime.agent.resolveAgentDir(cfg);
const result = await api.runtime.agent.runEmbeddedPiAgent({
  sessionId: "my-plugin:task-1",
  runId: crypto.randomUUID(),
  sessionFile: path.join(agentDir, "sessions", "my-plugin-task-1.jsonl"),
  workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg),
  prompt: "Summarize the latest changes",
  timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(cfg),
});
```

**セッションストアヘルパー**は`api.runtime.agent.session`配下にあります：

```typescript
const storePath = api.runtime.agent.session.resolveStorePath(cfg);
const store = api.runtime.agent.session.loadSessionStore(cfg);
await api.runtime.agent.session.saveSessionStore(cfg, store);
const filePath = api.runtime.agent.session.resolveSessionFilePath(cfg, sessionId);
```

### `api.runtime.agent.defaults`

デフォルトのモデルとプロバイダー定数：

```typescript
const model = api.runtime.agent.defaults.model; // e.g. "anthropic/claude-sonnet-4-6"
const provider = api.runtime.agent.defaults.provider; // e.g. "anthropic"
```

### `api.runtime.subagent`

バックグラウンドサブエージェントの起動と管理。

```typescript
// Start a subagent run
const { runId } = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "Expand this query into focused follow-up searches.",
  provider: "openai", // optional override
  model: "gpt-4.1-mini", // optional override
  deliver: false,
});

// Wait for completion
const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });

// Read session messages
const { messages } = await api.runtime.subagent.getSessionMessages({
  sessionKey: "agent:main:subagent:search-helper",
  limit: 10,
});

// Delete a session
await api.runtime.subagent.deleteSession({
  sessionKey: "agent:main:subagent:search-helper",
});
```

<Warning>
  モデルオーバーライド（`provider`/`model`）を使用するには、設定で`plugins.entries.<id>.subagent.allowModelOverride: true`によるオペレーターのオプトインが必要です。
  信頼されていないプラグインもサブエージェントを実行できますが、オーバーライドリクエストは拒否されます。
</Warning>

### `api.runtime.tts`

テキスト読み上げ合成。

```typescript
// Standard TTS
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

// Telephony-optimized TTS
const telephonyClip = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

// List available voices
const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

コアの`messages.tts`設定とプロバイダー選択を使用します。PCMオーディオバッファとサンプルレートを返します。

### `api.runtime.mediaUnderstanding`

画像、オーディオ、およびビデオの分析。

```typescript
// Describe an image
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

// Transcribe audio
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  mime: "audio/ogg", // optional, for when MIME cannot be inferred
});

// Describe a video
const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});

// Generic file analysis
const result = await api.runtime.mediaUnderstanding.runFile({
  filePath: "/tmp/inbound-file.pdf",
  cfg: api.config,
});
```

出力が生成されない場合（例：スキップされた入力）は`{ text: undefined }`を返します。

<Info>
  `api.runtime.stt.transcribeAudioFile(...)`は`api.runtime.mediaUnderstanding.transcribeAudioFile(...)`の互換エイリアスとして引き続き利用可能です。
</Info>

### `api.runtime.imageGeneration`

画像生成。

```typescript
const result = await api.runtime.imageGeneration.generate({
  prompt: "A robot painting a sunset",
  cfg: api.config,
});

const providers = api.runtime.imageGeneration.listProviders({ cfg: api.config });
```

### `api.runtime.webSearch`

ウェブ検索。

```typescript
const providers = api.runtime.webSearch.listProviders({ config: api.config });

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: { query: "OpenClaw plugin SDK", count: 5 },
});
```

### `api.runtime.media`

低レベルメディアユーティリティ。

```typescript
const webMedia = await api.runtime.media.loadWebMedia(url);
const mime = await api.runtime.media.detectMime(buffer);
const kind = api.runtime.media.mediaKindFromMime("image/jpeg"); // "image"
const isVoice = api.runtime.media.isVoiceCompatibleAudio(filePath);
const metadata = await api.runtime.media.getImageMetadata(filePath);
const resized = await api.runtime.media.resizeToJpeg(buffer, { maxWidth: 800 });
```

### `api.runtime.config`

設定の読み込みと書き込み。

```typescript
const cfg = await api.runtime.config.loadConfig();
await api.runtime.config.writeConfigFile(cfg);
```

### `api.runtime.system`

システムレベルのユーティリティ。

```typescript
await api.runtime.system.enqueueSystemEvent(event);
api.runtime.system.requestHeartbeatNow();
const output = await api.runtime.system.runCommandWithTimeout(cmd, args, opts);
const hint = api.runtime.system.formatNativeDependencyHint(pkg);
```

### `api.runtime.events`

イベントサブスクリプション。

```typescript
api.runtime.events.onAgentEvent((event) => {
  /* ... */
});
api.runtime.events.onSessionTranscriptUpdate((update) => {
  /* ... */
});
```

### `api.runtime.logging`

ロギング。

```typescript
const verbose = api.runtime.logging.shouldLogVerbose();
const childLogger = api.runtime.logging.getChildLogger({ plugin: "my-plugin" }, { level: "debug" });
```

### `api.runtime.modelAuth`

モデルおよびプロバイダー認証の解決。

```typescript
const auth = await api.runtime.modelAuth.getApiKeyForModel({ model, cfg });
const providerAuth = await api.runtime.modelAuth.resolveApiKeyForProvider({
  provider: "openai",
  cfg,
});
```

### `api.runtime.state`

状態ディレクトリの解決。

```typescript
const stateDir = api.runtime.state.resolveStateDir();
```

### `api.runtime.tools`

メモリツールファクトリとCLI。

```typescript
const getTool = api.runtime.tools.createMemoryGetTool(/* ... */);
const searchTool = api.runtime.tools.createMemorySearchTool(/* ... */);
api.runtime.tools.registerMemoryCli(/* ... */);
```

### `api.runtime.channel`

チャネル固有のランタイムヘルパー（チャネルプラグインが読み込まれている場合に利用可能）。

## ランタイム参照の保存

`register`コールバックの外でランタイム参照を使用するには、`createPluginRuntimeStore`を使用します：

```typescript
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>("my-plugin runtime not initialized");

// In your entry point
export default defineChannelPluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Example",
  plugin: myPlugin,
  setRuntime: store.setRuntime,
});

// In other files
export function getRuntime() {
  return store.getRuntime(); // throws if not initialized
}

export function tryGetRuntime() {
  return store.tryGetRuntime(); // returns null if not initialized
}
```

## その他のトップレベル`api`フィールド

`api.runtime`に加えて、APIオブジェクトは以下も提供します：

| フィールド               | 型                        | 説明                                                             |
| ------------------------ | ------------------------- | ---------------------------------------------------------------- |
| `api.id`                 | `string`                  | プラグインID                                                     |
| `api.name`               | `string`                  | プラグインの表示名                                               |
| `api.config`             | `OpenClawConfig`          | 現在の設定スナップショット                                       |
| `api.pluginConfig`       | `Record<string, unknown>` | `plugins.entries.<id>.config`からのプラグイン固有の設定           |
| `api.logger`             | `PluginLogger`            | スコープ付きロガー（`debug`、`info`、`warn`、`error`）           |
| `api.registrationMode`   | `PluginRegistrationMode`  | `"full"`、`"setup-only"`、`"setup-runtime"`、または`"cli-metadata"` |
| `api.resolvePath(input)` | `(string) => string`      | プラグインルートからの相対パスを解決する                         |

## 関連

- [SDK 概要](/plugins/sdk-overview) -- サブパスリファレンス
- [SDK エントリーポイント](/plugins/sdk-entrypoints) -- `definePluginEntry`オプション
- [プラグイン内部構造](/plugins/architecture) -- 機能モデルとレジストリ
