---
summary: "計画: すべてのメッセージングコネクタ向けのクリーンなプラグイン SDK + ランタイム"
read_when:
  - プラグインアーキテクチャを定義またはリファクタリングする場合
  - チャンネルコネクタをプラグイン SDK/ランタイムに移行する場合
title: "プラグイン SDK リファクタリング"
---

# プラグイン SDK + ランタイムリファクタリング計画

目標: すべてのメッセージングコネクタは、1 つの安定した API を使用するプラグイン（バンドルまたは外部）です。
プラグインは `src/**` から直接インポートしません。すべての依存関係は SDK またはランタイムを通じて行われます。

## なぜ今か

- 現在のコネクタはパターンが混在しています: 直接コアインポート、dist のみのブリッジ、カスタムヘルパー。
- これによりアップグレードが脆くなり、クリーンな外部プラグインサーフェスがブロックされます。

## ターゲットアーキテクチャ（2 つのレイヤー）

### 1) プラグイン SDK（コンパイル時、安定、公開可能）

スコープ: タイプ、ヘルパー、コンフィグユーティリティ。ランタイム状態なし、副作用なし。

コンテンツ（例）:

- タイプ: `ChannelPlugin`、アダプタ、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- コンフィグヘルパー: `buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、`applyAccountNameToChannelSection`。
- ペアリングヘルパー: `PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- オンボーディングヘルパー: `promptChannelAccessConfig`、`addWildcardAllowFrom`、オンボーディングタイプ。
- ツールパラメータヘルパー: `createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- ドキュメントリンクヘルパー: `formatDocsLink`。

デリバリー:

- `openclaw/plugin-sdk` として公開（またはコアから `openclaw/plugin-sdk` としてエクスポート）。
- 明示的な安定性保証付きのセムバー。

### 2) プラグインランタイム（実行サーフェス、注入）

スコープ: コアランタイム動作に触れるすべてもの。
`OpenClawPluginApi.runtime` 経由でアクセス。プラグインが `src/**` をインポートしない。

提案するサーフェス（最小限だが完全）:

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
      createReplyDispatcherWithTyping?: unknown; // Teams スタイルフロー用アダプタ
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: RoutePeerKind; id: string };
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

メモ:

- ランタイムはコア動作にアクセスする唯一の方法です。
- SDK は意図的に小さく安定しています。
- 各ランタイムメソッドは既存のコア実装にマッピングされます（重複なし）。

## 移行計画（フェーズ分け、安全）

### フェーズ 0: スキャフォールディング

- `openclaw/plugin-sdk` を導入。
- 上記のサーフェスで `OpenClawPluginApi` に `api.runtime` を追加。
- 移行ウィンドウ中の既存インポートを維持（非推奨警告）。

### フェーズ 1: ブリッジのクリーンアップ（低リスク）

- 拡張機能ごとの `core-bridge.ts` を `api.runtime` に置き換え。
- BlueBubbles、Zalo、Zalo Personal を最初に移行（すでに近い状態）。
- 重複したブリッジコードを削除。

### フェーズ 2: 軽量な直接インポートプラグイン

- Matrix を SDK + ランタイムに移行。
- オンボーディング、ディレクトリ、グループメンションロジックを検証。

### フェーズ 3: 重量級な直接インポートプラグイン

- MS Teams を移行（最大のランタイムヘルパーセット）。
- 返信/タイピングセマンティクスが現在の動作と一致することを確認。

### フェーズ 4: iMessage のプラグイン化

- iMessage を `extensions/imessage` に移動。
- 直接コア呼び出しを `api.runtime` に置き換え。
- コンフィグキー、CLI 動作、ドキュメントをそのまま維持。

### フェーズ 5: 強制

- Lint ルール / CI チェックを追加: `extensions/**` から `src/**` へのインポートなし。
- プラグイン SDK/バージョン互換性チェックを追加（ランタイム + SDK セムバー）。

## 互換性とバージョニング

- SDK: セムバー、公開、変更のドキュメント化。
- ランタイム: コアリリースごとにバージョン管理。`api.runtime.version` を追加。
- プラグインは必要なランタイム範囲を宣言（例: `openclawRuntime: ">=2026.2.0"`）。

## テスト戦略

- アダプタレベルのユニットテスト（実際のコア実装でランタイム関数を実行）。
- プラグインごとのゴールデンテスト: 動作のドリフトがないことを確認（ルーティング、ペアリング、アローリスト、メンションゲーティング）。
- CI で使用する単一の E2E プラグインサンプル（インストール + 実行 + スモーク）。

## 未解決の質問

- SDK タイプのホスト先: 別パッケージかコアエクスポートか？
- ランタイムタイプの配布: SDK（タイプのみ）かコアか？
- バンドルプラグインと外部プラグインのドキュメントリンクをどのように公開するか？
- 移行中にリポジトリ内プラグインが限定的な直接コアインポートを許可するか？

## 成功基準

- すべてのチャンネルコネクタが SDK + ランタイムを使用するプラグインです。
- `extensions/**` から `src/**` へのインポートなし。
- 新しいコネクタテンプレートは SDK + ランタイムのみに依存。
- 外部プラグインはコアソースアクセスなしで開発・更新できます。

関連ドキュメント: [プラグイン](/tools/plugin)、[チャンネル](/channels/index)、[設定](/gateway/configuration)。
