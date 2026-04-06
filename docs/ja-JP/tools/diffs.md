---
read_when:
    - エージェントにコードやMarkdownの編集内容を差分として表示させたい場合
    - キャンバス対応のビューアーURLやレンダリングされた差分ファイルが必要な場合
    - 安全なデフォルト設定で制御された一時的な差分アーティファクトが必要な場合
summary: エージェント向けの読み取り専用差分ビューアーおよびファイルレンダラー（オプションのプラグインツール）
title: Diffs
x-i18n:
    generated_at: "2026-04-02T09:02:10Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5ffb71a1c780c629b6e97bfe776684f87c7c482bf11860982b8134a9bdd87810
    source_path: tools/diffs.md
    workflow: 15
---

# Diffs

`diffs` は、短い組み込みシステムガイダンスとコンパニオン Skill を備えたオプションのプラグインツールで、変更内容を読み取り専用の差分アーティファクトに変換します。

以下のいずれかを入力として受け付けます：

- `before` と `after` のテキスト
- unified 形式の `patch`

以下を返すことができます：

- キャンバス表示用の Gateway ゲートウェイビューアー URL
- メッセージ配信用のレンダリングされたファイルパス（PNG または PDF）
- 1回の呼び出しで両方の出力

有効にすると、プラグインはシステムプロンプト領域に簡潔な使い方ガイダンスを付加し、エージェントがより詳細な指示を必要とする場合に備えて詳細な Skill も公開します。

## クイックスタート

1. プラグインを有効にします。
2. キャンバス優先のフローには `diffs` を `mode: "view"` で呼び出します。
3. チャットファイル配信フローには `diffs` を `mode: "file"` で呼び出します。
4. 両方のアーティファクトが必要な場合は `diffs` を `mode: "both"` で呼び出します。

## プラグインの有効化

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
      },
    },
  },
}
```

## 組み込みシステムガイダンスの無効化

`diffs` ツールは有効にしたまま組み込みシステムプロンプトガイダンスを無効にしたい場合は、`plugins.entries.diffs.hooks.allowPromptInjection` を `false` に設定します：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
      },
    },
  },
}
```

これにより、diffs プラグインの `before_prompt_build` フックがブロックされますが、プラグイン、ツール、コンパニオン Skill は引き続き利用できます。

ガイダンスとツールの両方を無効にしたい場合は、代わりにプラグイン自体を無効にしてください。

## 典型的なエージェントのワークフロー

1. エージェントが `diffs` を呼び出します。
2. エージェントが `details` フィールドを読み取ります。
3. エージェントは以下のいずれかを行います：
   - `details.viewerUrl` を `canvas present` で開く
   - `details.filePath` を `message` で `path` または `filePath` を使って送信する
   - 両方を行う

## 入力例

before と after：

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

パッチ：

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## ツール入力リファレンス

特に記載がない限り、すべてのフィールドはオプションです：

- `before`（`string`）：元のテキスト。`patch` が省略された場合、`after` と一緒に必須。
- `after`（`string`）：更新後のテキスト。`patch` が省略された場合、`before` と一緒に必須。
- `patch`（`string`）：unified diff テキスト。`before` および `after` とは排他的。
- `path`（`string`）：before/after モードの表示ファイル名。
- `lang`（`string`）：before/after モードの言語オーバーライドヒント。不明な値はプレーンテキストにフォールバックします。
- `title`（`string`）：ビューアーのタイトルオーバーライド。
- `mode`（`"view" | "file" | "both"`）：出力モード。デフォルトはプラグインデフォルトの `defaults.mode`。
  非推奨エイリアス：`"image"` は `"file"` と同様に動作し、後方互換性のためにまだ受け付けられます。
- `theme`（`"light" | "dark"`）：ビューアーのテーマ。デフォルトはプラグインデフォルトの `defaults.theme`。
- `layout`（`"unified" | "split"`）：差分レイアウト。デフォルトはプラグインデフォルトの `defaults.layout`。
- `expandUnchanged`（`boolean`）：完全なコンテキストが利用可能な場合に未変更セクションを展開します。呼び出しごとのオプションのみ（プラグインデフォルトのキーではありません）。
- `fileFormat`（`"png" | "pdf"`）：レンダリングファイル形式。デフォルトはプラグインデフォルトの `defaults.fileFormat`。
- `fileQuality`（`"standard" | "hq" | "print"`）：PNG または PDF レンダリングの品質プリセット。
- `fileScale`（`number`）：デバイススケールオーバーライド（`1`〜`4`）。
- `fileMaxWidth`（`number`）：CSSピクセル単位の最大レンダリング幅（`640`〜`2400`）。
- `ttlSeconds`（`number`）：ビューアーアーティファクトの TTL（秒）。デフォルト 1800、最大 21600。
- `baseUrl`（`string`）：ビューアー URL のオリジンオーバーライド。プラグインの `viewerBaseUrl` をオーバーライドします。`http` または `https` である必要があり、クエリ/ハッシュは不可。

バリデーションと制限：

- `before` と `after` はそれぞれ最大 512 KiB。
- `patch` は最大 2 MiB。
- `path` は最大 2048 バイト。
- `lang` は最大 128 バイト。
- `title` は最大 1024 バイト。
- パッチの複雑さの上限：最大 128 ファイル、合計 120000 行。
- `patch` と `before` または `after` の同時指定は拒否されます。
- レンダリングファイルの安全制限（PNG と PDF に適用）：
  - `fileQuality: "standard"`：最大 8 MP（8,000,000 レンダリングピクセル）。
  - `fileQuality: "hq"`：最大 14 MP（14,000,000 レンダリングピクセル）。
  - `fileQuality: "print"`：最大 24 MP（24,000,000 レンダリングピクセル）。
  - PDF はさらに最大 50 ページの制限があります。

## 出力 details コントラクト

ツールは `details` の下に構造化メタデータを返します。

ビューアーを作成するモードの共通フィールド：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`
- `context`（`agentId`、`sessionId`、`messageChannel`、`agentAccountId`、利用可能な場合）

PNG または PDF がレンダリングされた場合のファイルフィールド：

- `artifactId`
- `expiresAt`
- `filePath`
- `path`（`filePath` と同じ値、message ツールとの互換性のため）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

モード動作のまとめ：

- `mode: "view"`：ビューアーフィールドのみ。
- `mode: "file"`：ファイルフィールドのみ、ビューアーアーティファクトなし。
- `mode: "both"`：ビューアーフィールドとファイルフィールドの両方。ファイルレンダリングに失敗した場合でも、ビューアーは `fileError` とともに返されます。

## 折りたたまれた未変更セクション

- ビューアーは `N unmodified lines` のような行を表示できます。
- それらの行の展開コントロールは条件付きであり、すべての入力種別で保証されるわけではありません。
- 展開コントロールは、レンダリングされた差分に展開可能なコンテキストデータがある場合に表示されます。これは before/after 入力で一般的です。
- 多くの unified パッチ入力では、パースされたパッチハンクに省略されたコンテキスト本体が含まれていないため、展開コントロールなしで行が表示される場合があります。これは想定された動作です。
- `expandUnchanged` は展開可能なコンテキストが存在する場合にのみ適用されます。

## プラグインデフォルト

`~/.openclaw/openclaw.json` でプラグイン全体のデフォルトを設定します：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          defaults: {
            fontFamily: "Fira Code",
            fontSize: 15,
            lineSpacing: 1.6,
            layout: "unified",
            showLineNumbers: true,
            diffIndicators: "bars",
            wordWrap: true,
            background: true,
            theme: "dark",
            fileFormat: "png",
            fileQuality: "standard",
            fileScale: 2,
            fileMaxWidth: 960,
            mode: "both",
          },
        },
      },
    },
  },
}
```

サポートされるデフォルト：

- `fontFamily`
- `fontSize`
- `lineSpacing`
- `layout`
- `showLineNumbers`
- `diffIndicators`
- `wordWrap`
- `background`
- `theme`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`
- `mode`

明示的なツールパラメータはこれらのデフォルトをオーバーライドします。

永続的なビューアー URL 設定：

- `viewerBaseUrl`（`string`、オプション）
  - ツール呼び出しで `baseUrl` が渡されない場合に返されるビューアーリンクのプラグイン所有フォールバック。
  - `http` または `https` である必要があり、クエリ/ハッシュは不可。

例：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          viewerBaseUrl: "https://gateway.example.com/openclaw",
        },
      },
    },
  },
}
```

## セキュリティ設定

- `security.allowRemoteViewer`（`boolean`、デフォルト `false`）
  - `false`：ビューアールートへの非ループバックリクエストが拒否されます。
  - `true`：トークン化されたパスが有効であればリモートビューアーが許可されます。

例：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          security: {
            allowRemoteViewer: false,
          },
        },
      },
    },
  },
}
```

## アーティファクトのライフサイクルとストレージ

- アーティファクトは一時サブフォルダ `$TMPDIR/openclaw-diffs` に保存されます。
- ビューアーアーティファクトのメタデータには以下が含まれます：
  - ランダムなアーティファクト ID（16進数 20 文字）
  - ランダムなトークン（16進数 48 文字）
  - `createdAt` と `expiresAt`
  - 保存された `viewer.html` のパス
- 指定されない場合のデフォルトビューアー TTL は 30 分です。
- 受け入れられる最大ビューアー TTL は 6 時間です。
- クリーンアップはアーティファクト作成後に日和見的に実行されます。
- 期限切れのアーティファクトは削除されます。
- メタデータが欠落している場合、24 時間以上経過した古いフォルダのフォールバッククリーンアップが実行されます。

## ビューアー URL とネットワーク動作

ビューアールート：

- `/plugins/diffs/view/{artifactId}/{token}`

ビューアーアセット：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

ビューアードキュメントはこれらのアセットをビューアー URL からの相対パスで解決するため、オプションの `baseUrl` パスプレフィックスは両方のアセットリクエストでも保持されます。

URL 構築の動作：

- ツール呼び出しの `baseUrl` が指定された場合、厳密なバリデーション後に使用されます。
- そうでなく、プラグインの `viewerBaseUrl` が設定されている場合、それが使用されます。
- どちらのオーバーライドもない場合、ビューアー URL はループバック `127.0.0.1` がデフォルトになります。
- Gateway ゲートウェイのバインドモードが `custom` で `gateway.customBindHost` が設定されている場合、そのホストが使用されます。

`baseUrl` ルール：

- `http://` または `https://` である必要があります。
- クエリとハッシュは拒否されます。
- オリジンとオプションのベースパスが許可されます。

## セキュリティモデル

ビューアーの堅牢化：

- デフォルトでループバックのみ。
- 厳密な ID とトークンバリデーションによるトークン化されたビューアーパス。
- ビューアーレスポンス CSP：
  - `default-src 'none'`
  - スクリプトとアセットは self からのみ
  - 外部への `connect-src` なし
- リモートアクセスが有効な場合のリモートミススロットリング：
  - 60 秒あたり 40 回の失敗
  - 60 秒のロックアウト（`429 Too Many Requests`）

ファイルレンダリングの堅牢化：

- スクリーンショットブラウザのリクエストルーティングはデフォルトで拒否。
- `http://127.0.0.1/plugins/diffs/assets/*` からのローカルビューアーアセットのみ許可。
- 外部ネットワークリクエストはブロック。

## ファイルモードのブラウザ要件

`mode: "file"` と `mode: "both"` には Chromium 互換ブラウザが必要です。

解決順序：

1. OpenClaw 設定の `browser.executablePath`。
2. 環境変数：
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. プラットフォームのコマンド/パスディスカバリーフォールバック。

一般的なエラーメッセージ：

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

Chrome、Chromium、Edge、または Brave をインストールするか、上記の実行可能パスオプションのいずれかを設定して修正してください。

## トラブルシューティング

入力バリデーションエラー：

- `Provide patch or both before and after text.`
  - `before` と `after` の両方を含めるか、`patch` を指定してください。
- `Provide either patch or before/after input, not both.`
  - 入力モードを混在させないでください。
- `Invalid baseUrl: ...`
  - `http(s)` のオリジンとオプションのパスを使用し、クエリ/ハッシュは含めないでください。
- `{field} exceeds maximum size (...)`
  - ペイロードサイズを削減してください。
- 大きなパッチの拒否
  - パッチのファイル数または合計行数を削減してください。

ビューアーのアクセシビリティの問題：

- ビューアー URL はデフォルトで `127.0.0.1` に解決されます。
- リモートアクセスのシナリオでは、以下のいずれかを行ってください：
  - プラグインの `viewerBaseUrl` を設定する、または
  - ツール呼び出しごとに `baseUrl` を渡す、または
  - `gateway.bind=custom` と `gateway.customBindHost` を使用する
- `gateway.trustedProxies` が同一ホストプロキシ（例：Tailscale Serve）のためにループバックを含む場合、転送されたクライアント IP ヘッダーなしの生のループバックビューアーリクエストは設計上失敗します。
- そのプロキシトポロジの場合：
  - 添付ファイルのみが必要な場合は `mode: "file"` または `mode: "both"` を優先してください、または
  - 共有可能なビューアー URL が必要な場合は、意図的に `security.allowRemoteViewer` を有効にし、プラグインの `viewerBaseUrl` を設定するか、プロキシ/パブリックの `baseUrl` を渡してください
- 外部ビューアーアクセスを意図する場合にのみ `security.allowRemoteViewer` を有効にしてください。

未変更行の行に展開ボタンがない場合：

- パッチ入力でパッチに展開可能なコンテキストが含まれていない場合に発生する可能性があります。
- これは想定された動作であり、ビューアーの障害を示すものではありません。

アーティファクトが見つからない場合：

- TTL によりアーティファクトが期限切れになった。
- トークンまたはパスが変更された。
- クリーンアップにより古いデータが削除された。

## 運用ガイダンス

- キャンバスでのローカルなインタラクティブレビューには `mode: "view"` を優先してください。
- 添付ファイルが必要な送信チャットチャネルには `mode: "file"` を優先してください。
- デプロイメントでリモートビューアー URL が必要な場合を除き、`allowRemoteViewer` は無効のままにしてください。
- 機密性の高い差分には明示的に短い `ttlSeconds` を設定してください。
- 必要がない限り、差分入力にシークレットを含めないでください。
- チャネルが画像を強く圧縮する場合（例：Telegram や WhatsApp）、PDF 出力（`fileFormat: "pdf"`）を優先してください。

差分レンダリングエンジン：

- [Diffs](https://diffs.com) によって提供されています。

## 関連ドキュメント

- [ツール概要](/tools)
- [プラグイン](/tools/plugin)
- [ブラウザ](/tools/browser)
