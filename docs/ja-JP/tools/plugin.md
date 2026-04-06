---
read_when:
    - プラグインのインストールまたは設定を行う場合
    - プラグインのディスカバリーとロードルールを理解したい場合
    - Codex/Claude互換のプラグインバンドルを扱う場合
sidebarTitle: Install and Configure
summary: OpenClawプラグインのインストール、設定、管理
title: プラグイン
x-i18n:
    generated_at: "2026-04-02T07:56:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 08b818dbb27ab5bd7b8033646c4fca823dd30dc698541e05d6df39ceb4227c4d
    source_path: tools/plugin.md
    workflow: 15
---

# プラグイン

プラグインはOpenClawにチャネル、モデルプロバイダー、ツール、
Skills、音声、画像生成などの新しい機能を追加します。**コア**プラグイン（OpenClawに同梱）と
**外部**プラグイン（コミュニティによりnpmで公開）があります。

## クイックスタート

<Steps>
  <Step title="ロード済みのプラグインを確認する">
    ```bash
    openclaw plugins list
    ```
  </Step>

  <Step title="プラグインをインストールする">
    ```bash
    # npmから
    openclaw plugins install @openclaw/voice-call

    # ローカルディレクトリまたはアーカイブから
    openclaw plugins install ./my-plugin
    openclaw plugins install ./my-plugin.tgz
    ```

  </Step>

  <Step title="Gateway ゲートウェイを再起動する">
    ```bash
    openclaw gateway restart
    ```

    その後、設定ファイルの `plugins.entries.\<id\>.config` で設定を行います。

  </Step>
</Steps>

チャットネイティブな操作を好む場合は、`commands.plugins: true` を有効にして以下を使用してください:

```text
/plugin install clawhub:@openclaw/voice-call
/plugin show voice-call
/plugin enable voice-call
```

インストールパスはCLIと同じリゾルバーを使用します: ローカルパス/アーカイブ、明示的な
`clawhub:<pkg>`、またはベアパッケージ指定（ClawHub優先、次にnpmフォールバック）。

## プラグインの種類

OpenClawは2つのプラグイン形式を認識します:

| 形式       | 動作                                                               | 例                                                     |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| **ネイティブ** | `openclaw.plugin.json` + ランタイムモジュール; インプロセスで実行  | 公式プラグイン、コミュニティnpmパッケージ              |
| **バンドル** | Codex/Claude/Cursor互換のレイアウト; OpenClawの機能にマッピング    | `.codex-plugin/`、`.claude-plugin/`、`.cursor-plugin/` |

どちらも `openclaw plugins list` に表示されます。バンドルの詳細は[プラグインバンドル](/plugins/bundles)を参照してください。

ネイティブプラグインを作成する場合は、[プラグインの作成](/plugins/building-plugins)
と[プラグインSDK 概要](/plugins/sdk-overview)から始めてください。

## 公式プラグイン

### インストール可能（npm）

| プラグイン      | パッケージ             | ドキュメント                         |
| --------------- | ---------------------- | ------------------------------------ |
| Matrix          | `@openclaw/matrix`     | [Matrix](/channels/matrix)           |
| Microsoft Teams | `@openclaw/msteams`    | [Microsoft Teams](/channels/msteams) |
| Nostr           | `@openclaw/nostr`      | [Nostr](/channels/nostr)             |
| Voice Call      | `@openclaw/voice-call` | [Voice Call](/plugins/voice-call)    |
| Zalo            | `@openclaw/zalo`       | [Zalo](/channels/zalo)               |
| Zalo Personal   | `@openclaw/zalouser`   | [Zalo Personal](/plugins/zalouser)   |

### コア（OpenClawに同梱）

<AccordionGroup>
  <Accordion title="モデルプロバイダー（デフォルトで有効）">
    `anthropic`、`byteplus`、`cloudflare-ai-gateway`、`github-copilot`、`google`、
    `huggingface`、`kilocode`、`kimi-coding`、`minimax`、`mistral`、`modelstudio`、
    `moonshot`、`nvidia`、`openai`、`opencode`、`opencode-go`、`openrouter`、
    `qianfan`、`synthetic`、`together`、`venice`、
    `vercel-ai-gateway`、`volcengine`、`xiaomi`、`zai`
  </Accordion>

  <Accordion title="メモリプラグイン">
    - `memory-core` — バンドルされたメモリ検索（`plugins.slots.memory` 経由のデフォルト）
    - `memory-lancedb` — 自動リコール/キャプチャ付きのオンデマンドインストール型長期メモリ（`plugins.slots.memory = "memory-lancedb"` で設定）
  </Accordion>

  <Accordion title="音声プロバイダー（デフォルトで有効）">
    `elevenlabs`、`microsoft`
  </Accordion>

  <Accordion title="その他">
    - `browser` — ブラウザツール、`openclaw browser` CLI、`browser.request` Gateway ゲートウェイメソッド、ブラウザランタイム、デフォルトのブラウザ制御サービス用のバンドルされたブラウザプラグイン（デフォルトで有効。置き換える前に無効にしてください）
    - `copilot-proxy` — VS Code Copilot Proxyブリッジ（デフォルトで無効）
  </Accordion>
</AccordionGroup>

サードパーティプラグインをお探しですか？[コミュニティプラグイン](/plugins/community)を参照してください。

## 設定

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

| フィールド       | 説明                                                      |
| ---------------- | --------------------------------------------------------- |
| `enabled`        | マスタートグル（デフォルト: `true`）                      |
| `allow`          | プラグイン許可リスト（オプション）                        |
| `deny`           | プラグイン拒否リスト（オプション。拒否が優先）            |
| `load.paths`     | 追加のプラグインファイル/ディレクトリ                     |
| `slots`          | 排他スロットセレクター（例: `memory`、`contextEngine`）   |
| `entries.\<id\>` | プラグインごとのトグルと設定                              |

設定変更には**Gateway ゲートウェイの再起動が必要です**。Gateway ゲートウェイが設定監視 +
インプロセス再起動を有効にして実行されている場合（デフォルトの `openclaw gateway` パス）、
通常は設定の書き込み後すぐに自動的に再起動が実行されます。

<Accordion title="プラグインの状態: 無効 vs 不明 vs 無効な設定">
  - **無効（Disabled）**: プラグインは存在するが、有効化ルールによりオフにされた状態。設定は保持されます。
  - **不明（Missing）**: 設定がディスカバリーで見つからなかったプラグインIDを参照しています。
  - **無効な設定（Invalid）**: プラグインは存在するが、設定が宣言されたスキーマに一致しません。
</Accordion>

## ディスカバリーと優先順位

OpenClawは以下の順序でプラグインをスキャンします（最初に一致したものが優先）:

<Steps>
  <Step title="設定パス">
    `plugins.load.paths` — 明示的なファイルまたはディレクトリパス。
  </Step>

  <Step title="ワークスペース拡張">
    `\<workspace\>/.openclaw/<plugin-root>/*.ts` および `\<workspace\>/.openclaw/<plugin-root>/*/index.ts`。
  </Step>

  <Step title="グローバル拡張">
    `~/.openclaw/<plugin-root>/*.ts` および `~/.openclaw/<plugin-root>/*/index.ts`。
  </Step>

  <Step title="バンドルされたプラグイン">
    OpenClawに同梱。多くはデフォルトで有効（モデルプロバイダー、音声）。
    その他は明示的な有効化が必要です。
  </Step>
</Steps>

### 有効化ルール

- `plugins.enabled: false` はすべてのプラグインを無効にします
- `plugins.deny` は常に許可より優先されます
- `plugins.entries.\<id\>.enabled: false` はそのプラグインを無効にします
- ワークスペース由来のプラグインは**デフォルトで無効**です（明示的に有効化する必要があります）
- バンドルされたプラグインは、オーバーライドされない限りビルトインのデフォルト有効セットに従います
- 排他スロットは、そのスロットの選択されたプラグインを強制的に有効にできます

## プラグインスロット（排他カテゴリ）

一部のカテゴリは排他的です（一度にアクティブにできるのは1つのみ）:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // または "none" で無効化
      contextEngine: "legacy", // またはプラグインID
    },
  },
}
```

| スロット        | 制御対象              | デフォルト          |
| --------------- | --------------------- | ------------------- |
| `memory`        | アクティブなメモリプラグイン | `memory-core`       |
| `contextEngine` | アクティブなコンテキストエンジン | `legacy`（ビルトイン） |

## CLIリファレンス

```bash
openclaw plugins list                    # コンパクトなインベントリ
openclaw plugins inspect <id>            # 詳細情報
openclaw plugins inspect <id> --json     # 機械可読形式
openclaw plugins status                  # 運用サマリー
openclaw plugins doctor                  # 診断

openclaw plugins install <package>        # インストール（ClawHub優先、次にnpm）
openclaw plugins install clawhub:<pkg>   # ClawHubからのみインストール
openclaw plugins install <path>          # ローカルパスからインストール
openclaw plugins install -l <path>       # 開発用にリンク（コピーなし）
openclaw plugins install <spec> --dangerously-force-unsafe-install
openclaw plugins update <id>             # プラグインを1つ更新
openclaw plugins update --all            # すべて更新

openclaw plugins enable <id>
openclaw plugins disable <id>
```

`--dangerously-force-unsafe-install` は、ビルトインの危険コードスキャナーの誤検知に対するブレークグラスオーバーライドです。ビルトインの `critical` 検出結果を超えてインストールを続行できますが、プラグインの `before_install` ポリシーブロックやスキャン失敗によるブロックはバイパスしません。

このCLIフラグはプラグインのインストールにのみ適用されます。Gateway ゲートウェイベースのSkills依存関係インストールでは、代わりに対応する `dangerouslyForceUnsafeInstall` リクエストオーバーライドを使用します。一方、`openclaw skills install` は別個のClawHub Skillsダウンロード/インストールフローのままです。

[`openclaw plugins` CLIリファレンス](/cli/plugins)で詳細はこちら。

## プラグインAPIの概要

プラグインは関数または `register(api)` を持つオブジェクトをエクスポートします:

```typescript
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
    api.registerChannel({
      /* ... */
    });
  },
});
```

主な登録メソッド:

| メソッド                             | 登録対象             |
| ------------------------------------ | -------------------- |
| `registerProvider`                   | モデルプロバイダー（LLM） |
| `registerChannel`                    | チャットチャネル     |
| `registerTool`                       | エージェントツール   |
| `registerHook` / `on(...)`           | ライフサイクルフック |
| `registerSpeechProvider`             | テキスト読み上げ / STT |
| `registerMediaUnderstandingProvider` | 画像/音声分析        |
| `registerImageGenerationProvider`    | 画像生成             |
| `registerWebSearchProvider`          | Web検索              |
| `registerHttpRoute`                  | HTTPエンドポイント   |
| `registerCommand` / `registerCli`    | CLIコマンド          |
| `registerContextEngine`              | コンテキストエンジン |
| `registerService`                    | バックグラウンドサービス |

型付きライフサイクルフックのフックガード動作:

- `before_tool_call`: `{ block: true }` は終端的であり、低優先度のハンドラーはスキップされます。
- `before_tool_call`: `{ block: false }` はノーオプであり、先行するブロックをクリアしません。
- `before_install`: `{ block: true }` は終端的であり、低優先度のハンドラーはスキップされます。
- `before_install`: `{ block: false }` はノーオプであり、先行するブロックをクリアしません。
- `message_sending`: `{ cancel: true }` は終端的であり、低優先度のハンドラーはスキップされます。
- `message_sending`: `{ cancel: false }` はノーオプであり、先行するキャンセルをクリアしません。

型付きフックの動作の詳細は、[SDK 概要](/plugins/sdk-overview#hook-decision-semantics)を参照してください。

## 関連

- [プラグインの作成](/plugins/building-plugins) — 独自のプラグインを作成する
- [プラグインバンドル](/plugins/bundles) — Codex/Claude/Cursorバンドルの互換性
- [プラグインマニフェスト](/plugins/manifest) — マニフェストスキーマ
- [ツールの登録](/plugins/building-plugins#registering-agent-tools) — プラグインにエージェントツールを追加する
- [プラグイン内部構造](/plugins/architecture) — 機能モデルとロードパイプライン
- [コミュニティプラグイン](/plugins/community) — サードパーティの一覧
