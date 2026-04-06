---
read_when:
    - Codex、Claude、またはCursor互換バンドルをインストールしたい場合
    - OpenClaw がバンドルコンテンツをネイティブ機能にどのようにマッピングするか理解したい場合
    - バンドルの検出や不足している機能のデバッグを行う場合
summary: Codex、Claude、Cursorバンドルを OpenClaw プラグインとしてインストール・使用する
title: プラグインバンドル
x-i18n:
    generated_at: "2026-04-02T07:49:23Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 96502f6d6fb574d3ebd2040d37763fe21ee9d669cd8027710fac46c5d61c53ba
    source_path: plugins/bundles.md
    workflow: 15
---

# プラグインバンドル

OpenClaw は、**Codex**、**Claude**、**Cursor** の3つの外部エコシステムからプラグインをインストールできます。これらは **バンドル** と呼ばれ、OpenClaw が Skills、フック、MCPツールなどのネイティブ機能にマッピングするコンテンツおよびメタデータパックです。

<Info>
  バンドルはネイティブ OpenClaw プラグインとは **異なります**。ネイティブプラグインはインプロセスで実行され、任意の機能を登録できます。バンドルは選択的な機能マッピングとより狭い信頼境界を持つコンテンツパックです。
</Info>

## バンドルが存在する理由

多くの便利なプラグインが Codex、Claude、または Cursor 形式で公開されています。作者にネイティブ OpenClaw プラグインとして書き直すことを要求する代わりに、OpenClaw はこれらの形式を検出し、サポートされるコンテンツをネイティブ機能セットにマッピングします。これにより、Claude コマンドパックや Codex Skills バンドルをインストールしてすぐに使用できます。

## バンドルのインストール

<Steps>
  <Step title="ディレクトリ、アーカイブ、またはマーケットプレイスからインストール">
    ```bash
    # ローカルディレクトリ
    openclaw plugins install ./my-bundle

    # アーカイブ
    openclaw plugins install ./my-bundle.tgz

    # Claude マーケットプレイス
    openclaw plugins marketplace list <marketplace-name>
    openclaw plugins install <plugin-name>@<marketplace-name>
    ```

  </Step>

  <Step title="検出の確認">
    ```bash
    openclaw plugins list
    openclaw plugins inspect <id>
    ```

    バンドルは `Format: bundle` として表示され、サブタイプは `codex`、`claude`、または `cursor` になります。

  </Step>

  <Step title="再起動して使用">
    ```bash
    openclaw gateway restart
    ```

    マッピングされた機能（Skills、フック、MCPツール）は次のセッションで利用可能になります。

  </Step>
</Steps>

## OpenClaw がバンドルからマッピングするもの

すべてのバンドル機能が現在 OpenClaw で動作するわけではありません。以下に、動作するものと検出されるがまだ接続されていないものを示します。

### 現在サポートされているもの

| 機能 | マッピング方法 | 対象フォーマット |
| ------------- | ------------------------------------------------------------------------------------------- | -------------- |
| Skills コンテンツ | バンドルの Skills ルートが通常の OpenClaw Skills として読み込まれる | 全フォーマット |
| コマンド | `commands/` と `.cursor/commands/` が Skills ルートとして扱われる | Claude、Cursor |
| フックパック | OpenClaw スタイルの `HOOK.md` + `handler.ts` レイアウト | Codex |
| MCPツール | バンドルの MCP 設定が埋め込み Pi 設定にマージされ、サポートされる stdio および HTTP サーバーが読み込まれる | 全フォーマット |
| 設定 | Claude の `settings.json` が埋め込み Pi のデフォルトとしてインポートされる | Claude |

#### Skills コンテンツ

- バンドルの Skills ルートが通常の OpenClaw Skills ルートとして読み込まれる
- Claude の `commands` ルートが追加の Skills ルートとして扱われる
- Cursor の `.cursor/commands` ルートが追加の Skills ルートとして扱われる

これにより、Claude のマークダウンコマンドファイルは通常の OpenClaw Skills ローダーを通じて動作します。Cursor のコマンドマークダウンも同じパスで動作します。

#### フックパック

- バンドルのフックルートは、通常の OpenClaw フックパックレイアウトを使用している場合 **のみ** 動作します。現在これは主に Codex 互換のケースです：
  - `HOOK.md`
  - `handler.ts` または `handler.js`

#### Pi 向け MCP

- 有効化されたバンドルは MCP サーバー設定を提供できる
- OpenClaw はバンドルの MCP 設定を有効な埋め込み Pi 設定に `mcpServers` としてマージする
- OpenClaw は埋め込み Pi エージェントターン中に、stdio サーバーを起動するか HTTP サーバーに接続することで、サポートされるバンドル MCPツールを公開する
- プロジェクトローカルの Pi 設定はバンドルのデフォルトの後に適用されるため、ワークスペース設定は必要に応じてバンドルの MCP エントリを上書きできる

##### トランスポート

MCP サーバーは stdio または HTTP トランスポートを使用できます：

**Stdio** は子プロセスを起動します：

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "command": "node",
        "args": ["server.js"],
        "env": { "PORT": "3000" }
      }
    }
  }
}
```

**HTTP** はデフォルトで `sse` を使用して実行中の MCP サーバーに接続するか、要求された場合は `streamable-http` を使用します：

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "url": "http://localhost:3100/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer ${MY_SECRET_TOKEN}"
        },
        "connectionTimeoutMs": 30000
      }
    }
  }
}
```

- `transport` は `"streamable-http"` または `"sse"` に設定できます。省略した場合、OpenClaw は `sse` を使用します
- `http:` および `https:` の URL スキームのみが許可されます
- `headers` の値は `${ENV_VAR}` 補間をサポートします
- `command` と `url` の両方を持つサーバーエントリは拒否されます
- URL 資格情報（ユーザー情報とクエリパラメータ）はツールの説明とログから除去されます
- `connectionTimeoutMs` は stdio および HTTP トランスポートの両方でデフォルトの30秒接続タイムアウトを上書きします

##### ツールの命名

OpenClaw はバンドル MCPツールを `serverName__toolName` 形式のプロバイダー安全な名前で登録します。例えば、`"vigil-harbor"` というキーのサーバーが `memory_search` ツールを公開する場合、`vigil-harbor__memory_search` として登録されます。

- `A-Za-z0-9_-` 以外の文字は `-` に置換されます
- サーバープレフィックスは最大30文字に制限されます
- 完全なツール名は最大64文字に制限されます
- 空のサーバー名は `mcp` にフォールバックします
- サニタイズ後に衝突する名前は数値サフィックスで曖昧さが解消されます

#### 埋め込み Pi 設定

- バンドルが有効な場合、Claude の `settings.json` がデフォルトの埋め込み Pi 設定としてインポートされます
- OpenClaw はシェルオーバーライドキーを適用前にサニタイズします

サニタイズされるキー：

- `shellPath`
- `shellCommandPrefix`

### 検出されるが実行されないもの

以下は認識され診断に表示されますが、OpenClaw は実行しません：

- Claude の `agents`、`hooks.json` オートメーション、`lspServers`、`outputStyles`
- Cursor の `.cursor/agents`、`.cursor/hooks.json`、`.cursor/rules`
- 機能レポート以外の Codex インライン/アプリメタデータ

## バンドルフォーマット

<AccordionGroup>
  <Accordion title="Codex バンドル">
    マーカー: `.codex-plugin/plugin.json`

    オプションコンテンツ: `skills/`、`hooks/`、`.mcp.json`、`.app.json`

    Codex バンドルは、Skills ルートと OpenClaw スタイルのフックパックディレクトリ（`HOOK.md` + `handler.ts`）を使用する場合に OpenClaw と最も適合します。

  </Accordion>

  <Accordion title="Claude バンドル">
    2つの検出モード：

    - **マニフェストベース:** `.claude-plugin/plugin.json`
    - **マニフェストなし:** デフォルトの Claude レイアウト（`skills/`、`commands/`、`agents/`、`hooks/`、`.mcp.json`、`settings.json`）

    Claude 固有の動作：

    - `commands/` は Skills コンテンツとして扱われる
    - `settings.json` は埋め込み Pi 設定にインポートされる（シェルオーバーライドキーはサニタイズされる）
    - `.mcp.json` はサポートされる stdio ツールを埋め込み Pi に公開する
    - `hooks/hooks.json` は検出されるが実行されない
    - マニフェスト内のカスタムコンポーネントパスは加算的（デフォルトを置換するのではなく拡張する）

  </Accordion>

  <Accordion title="Cursor バンドル">
    マーカー: `.cursor-plugin/plugin.json`

    オプションコンテンツ: `skills/`、`.cursor/commands/`、`.cursor/agents/`、`.cursor/rules/`、`.cursor/hooks.json`、`.mcp.json`

    - `.cursor/commands/` は Skills コンテンツとして扱われる
    - `.cursor/rules/`、`.cursor/agents/`、`.cursor/hooks.json` は検出のみ

  </Accordion>
</AccordionGroup>

## 検出の優先順位

OpenClaw はまずネイティブプラグインフォーマットを確認します：

1. `openclaw.plugin.json` または `openclaw.extensions` を持つ有効な `package.json` — **ネイティブプラグイン** として扱われる
2. バンドルマーカー（`.codex-plugin/`、`.claude-plugin/`、またはデフォルトの Claude/Cursor レイアウト）— **バンドル** として扱われる

ディレクトリに両方が含まれる場合、OpenClaw はネイティブパスを使用します。これにより、デュアルフォーマットパッケージがバンドルとして部分的にインストールされることを防ぎます。

## セキュリティ

バンドルはネイティブプラグインよりも狭い信頼境界を持ちます：

- OpenClaw は任意のバンドルランタイムモジュールをインプロセスで読み込み **ません**
- Skills とフックパックのパスはプラグインルート内に留まる必要がある（境界チェック済み）
- 設定ファイルは同じ境界チェックで読み取られる
- サポートされる stdio MCP サーバーはサブプロセスとして起動される場合がある

これによりバンドルはデフォルトでより安全ですが、サードパーティのバンドルは公開する機能に対して信頼できるコンテンツとして扱う必要があります。

## トラブルシューティング

<AccordionGroup>
  <Accordion title="バンドルは検出されるが機能が動作しない">
    `openclaw plugins inspect <id>` を実行してください。機能がリストされているが接続されていないと表示される場合、それはインストールの問題ではなく製品の制限です。
  </Accordion>

  <Accordion title="Claude コマンドファイルが表示されない">
    バンドルが有効になっていること、およびマークダウンファイルが検出された `commands/` または `skills/` ルート内にあることを確認してください。
  </Accordion>

  <Accordion title="Claude 設定が適用されない">
    `settings.json` からの埋め込み Pi 設定のみがサポートされています。OpenClaw はバンドル設定を生の設定パッチとして扱いません。
  </Accordion>

  <Accordion title="Claude フックが実行されない">
    `hooks/hooks.json` は検出のみです。実行可能なフックが必要な場合は、OpenClaw フックパックレイアウトを使用するか、ネイティブプラグインを提供してください。
  </Accordion>
</AccordionGroup>

## 関連

- [プラグインのインストールと設定](/tools/plugin)
- [プラグインの構築](/plugins/building-plugins) — ネイティブプラグインの作成
- [プラグインマニフェスト](/plugins/manifest) — ネイティブマニフェストスキーマ
