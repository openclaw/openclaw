---
summary: "計画: すべてのメッセージング コネクター向けに、1 つのクリーンな プラグイン SDK + ランタイム"
read_when:
  - プラグイン アーキテクチャを定義またはリファクタリングする場合
  - チャンネル コネクターを プラグイン SDK / ランタイム に移行する場合
title: "プラグイン SDK リファクタ"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:07Z
---

# プラグイン SDK + ランタイム リファクタ計画

目標: すべてのメッセージング コネクターを、1 つの安定した API を使用するプラグイン（同梱または外部）にします。  
どのプラグインも `src/**` から直接 import しません。すべての依存関係は SDK またはランタイムを経由します。

## なぜ今なのか

- 現在のコネクターは、直接のコア import、dist のみのブリッジ、カスタム ヘルパーなど、パターンが混在しています。
- これによりアップグレードが不安定になり、クリーンな外部プラグイン向けの表面を提供できません。

## 目標アーキテクチャ（2 レイヤー）

### 1) プラグイン SDK（コンパイル時、安定、公開可能）

スコープ: 型、ヘルパー、設定ユーティリティ。ランタイム状態や副作用は含みません。

内容（例）:

- 型: `ChannelPlugin`、adapters、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- 設定ヘルパー: `buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、  
  `applyAccountNameToChannelSection`。
- ペアリング ヘルパー: `PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- オンボーディング ヘルパー: `promptChannelAccessConfig`、`addWildcardAllowFrom`、オンボーディング型。
- ツール パラメーター ヘルパー: `createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- ドキュメント リンク ヘルパー: `formatDocsLink`。

配布:

- `openclaw/plugin-sdk` として公開（または `openclaw/plugin-sdk` 配下でコアから export）。
- 明示的な安定性保証を伴う semver。

### 2) プラグイン ランタイム（実行面、注入）

スコープ: コアのランタイム挙動に触れるすべて。  
プラグインが `src/**` を import しないよう、`OpenClawPluginApi.runtime` 経由でアクセスします。

提案する表面（最小だが十分）:

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

注記:

- ランタイムは、コアの挙動へアクセスする唯一の手段です。
- SDK は意図的に小さく、安定しています。
- 各ランタイム メソッドは、既存のコア実装に対応します（重複なし）。

## 移行計画（段階的・安全）

### フェーズ 0: 足場作り

- `openclaw/plugin-sdk` を導入します。
- 上記の表面を持つ `api.runtime` を `OpenClawPluginApi` に追加します。
- 移行期間中は既存の import を維持します（非推奨警告あり）。

### フェーズ 1: ブリッジ整理（低リスク）

- 拡張ごとの `core-bridge.ts` を `api.runtime` に置き換えます。
- BlueBubbles、Zalo、Zalo Personal を最初に移行します（すでに近い状態）。
- 重複したブリッジ コードを削除します。

### フェーズ 2: 直接 import が軽いプラグイン

- Matrix を SDK + ランタイム に移行します。
- オンボーディング、ディレクトリ、グループ メンション ロジックを検証します。

### フェーズ 3: 直接 import が多いプラグイン

- MS Teams を移行します（ランタイム ヘルパーの最大セット）。
- 返信 / 入力中のセマンティクスが現在の挙動と一致することを確認します。

### フェーズ 4: iMessage のプラグイン化

- iMessage を `extensions/imessage` に移動します。
- 直接のコア呼び出しを `api.runtime` に置き換えます。
- 設定キー、CLI の挙動、ドキュメントはそのまま維持します。

### フェーズ 5: 強制

- lint ルール / CI チェックを追加: `src/**` からの `extensions/**` import を禁止します。
- プラグイン SDK / バージョン互換性チェックを追加します（ランタイム + SDK の semver）。

## 互換性とバージョニング

- SDK: semver、公開、変更点を文書化します。
- ランタイム: コア リリースごとにバージョン管理します。`api.runtime.version` を追加します。
- プラグインは必要なランタイム範囲を宣言します（例: `openclawRuntime: ">=2026.2.0"`）。

## テスト戦略

- アダプター レベルのユニット テスト（実コア実装でランタイム関数を実行）。
- プラグインごとのゴールデン テスト: 挙動の乖離がないことを確認します（ルーティング、ペアリング、許可リスト、メンション ゲーティング）。
- CI で使用する単一のエンドツーエンド プラグイン サンプル（インストール + 実行 + スモーク）。

## 未解決の質問

- SDK の型はどこに配置するべきか: 別パッケージか、コア export か。
- ランタイム型の配布方法: SDK（型のみ）か、コアか。
- 同梱プラグインと外部プラグインで、ドキュメント リンクをどのように公開するか。
- 移行期間中、リポジトリ内プラグインに限定して、直接のコア import を一部許可するか。

## 成功基準

- すべてのチャンネル コネクターが SDK + ランタイム を使用するプラグインであること。
- `src/**` からの `extensions/**` import がないこと。
- 新しいコネクター テンプレートが SDK + ランタイム のみに依存すること。
- 外部プラグインが、コア ソースへのアクセスなしに開発・更新できること。

関連ドキュメント: [Plugins](/tools/plugin)、[Channels](/channels/index)、[Configuration](/gateway/configuration)。
