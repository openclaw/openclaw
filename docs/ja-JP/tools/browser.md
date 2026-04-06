---
title: "ブラウザ（OpenClaw 管理）"
summary: "統合ブラウザコントロールサービス + アクションコマンド"
read_when:
  - エージェント制御のブラウザ自動化を追加する
  - openclaw が自分の Chrome に干渉している理由をデバッグする
  - macOS アプリでブラウザ設定 + ライフサイクルを実装する
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 96cf4dfdd02486b76ca6fab9f89cc6bc5510da24056065c608949fb1629151c9
    source_path: tools/browser.md
    workflow: 15
---

# ブラウザ（openclaw 管理）

OpenClaw はエージェントが制御する**専用の Chrome/Brave/Edge/Chromium プロファイル**を実行できます。
個人のブラウザからは分離されており、Gateway ゲートウェイ内部の小さなローカルコントロールサービス（ループバックのみ）を通じて管理されます。

初心者向けの説明：

- **エージェント専用の別個のブラウザ**として考えてください。
- `openclaw` プロファイルは個人のブラウザプロファイルに**触れません**。
- エージェントは安全なレーンで**タブを開き、ページを読み、クリックし、入力する**ことができます。
- 組み込みの `user` プロファイルは Chrome MCP を介して実際のサインイン済み Chrome セッションにアタッチします。

## 提供内容

- **openclaw** という名前の別個のブラウザプロファイル（デフォルトではオレンジアクセント）。
- 決定的なタブ制御（リスト/オープン/フォーカス/クローズ）。
- エージェントアクション（クリック/タイプ/ドラッグ/選択）、スナップショット、スクリーンショット、PDF。
- オプションのマルチプロファイルサポート（`openclaw`、`work`、`remote`など）。

## クイックスタート

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

「ブラウザが無効」と表示される場合は、設定で有効にして（以下を参照）Gateway ゲートウェイを再起動してください。

## プラグインコントロール

デフォルトの `browser` ツールは現在、デフォルトで有効なバンドルプラグインです：

```json5
{
  plugins: {
    entries: {
      browser: {
        enabled: false,
      },
    },
  },
}
```

## プロファイル: `openclaw` 対 `user`

- `openclaw`: 管理された、分離されたブラウザ（拡張機能不要）。
- `user`: **実際のサインイン済み Chrome** セッション用の組み込み Chrome MCP アタッチプロファイル。

エージェントのブラウザツール呼び出し：

- デフォルト: 分離された `openclaw` ブラウザを使用。
- 既存のログイン済みセッションが重要で、ユーザーがコンピューターにいてアタッチプロンプトをクリック/承認できる場合は `profile="user"` を優先。

## 設定

ブラウザ設定は `~/.openclaw/openclaw.json` にあります。

```json5
{
  browser: {
    enabled: true,
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true,
    },
    defaultProfile: "openclaw",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      user: {
        driver: "existing-session",
        attachOnly: true,
        color: "#00AA00",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

## Brave（または他の Chromium ベースのブラウザ）の使用

**システムデフォルト**ブラウザが Chromium ベース（Chrome/Brave/Edge など）の場合、OpenClaw は自動的にそれを使用します。`browser.executablePath` を設定して自動検出をオーバーライドしてください：

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

## ローカル対リモートコントロール

- **ローカルコントロール（デフォルト）**: Gateway ゲートウェイがループバックコントロールサービスを開始し、ローカルブラウザを起動できます。
- **リモートコントロール（ノードホスト）**: ブラウザを持つマシンでノードホストを実行；Gateway ゲートウェイがブラウザアクションをそこにプロキシします。
- **リモート CDP**: `browser.profiles.<name>.cdpUrl`（または `browser.cdpUrl`）を設定してリモート Chromium ベースのブラウザにアタッチします。

## Browserless（ホスト型リモート CDP）

[Browserless](https://browserless.io) は HTTPS と WebSocket 経由で CDP 接続 URL を公開するホスト型の Chromium サービスです。

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    profiles: {
      browserless: {
        cdpUrl: "wss://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

## Browserbase

[Browserbase](https://www.browserbase.com) は CAPTCHA 解決、ステルスモード、住宅プロキシを内蔵したヘッドレスブラウザを実行するクラウドプラットフォームです。

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserbase",
    profiles: {
      browserbase: {
        cdpUrl: "wss://connect.browserbase.com?apiKey=<BROWSERBASE_API_KEY>",
        color: "#F97316",
      },
    },
  },
}
```

## セキュリティ

主要な考え方：

- ブラウザコントロールはループバックのみ；アクセスは Gateway ゲートウェイの認証またはノードペアリングを通じて流れます。
- Gateway ゲートウェイとノードホストをプライベートネットワーク（Tailscale）上に保ってください；公開への露出を避けてください。
- リモート CDP URL/トークンをシークレットとして扱ってください；env vars またはシークレットマネージャーを優先してください。

## プロファイル（マルチブラウザ）

OpenClaw は複数の名前付きプロファイルをサポートします：

- **openclaw 管理**: 専用のユーザーデータディレクトリ + CDP ポートを持つ専用の Chromium ベースブラウザインスタンス
- **リモート**: 明示的な CDP URL（別の場所で実行されている Chromium ベースのブラウザ）
- **既存のセッション**: Chrome DevTools MCP 自動接続を介した既存の Chrome プロファイル

## 既存のセッション（Chrome DevTools MCP 経由）

OpenClaw は公式の Chrome DevTools MCP サーバーを通じて実行中の Chromium ベースのブラウザプロファイルにアタッチすることもできます。

アタッチのスモークテスト：

```bash
openclaw browser --browser-profile user start
openclaw browser --browser-profile user status
openclaw browser --browser-profile user tabs
openclaw browser --browser-profile user snapshot --format ai
```

## 分離の保証

- **専用のユーザーデータディレクトリ**: 個人のブラウザプロファイルに決して触れません。
- **専用のポート**: 開発ワークフローとの衝突を防ぐために `9222` を避けます。
- **決定的なタブコントロール**: `targetId` でタブをターゲットにし、「最後のタブ」ではない。

## CLI クイックリファレンス

すべてのコマンドは `--browser-profile <name>` を受け付けてプロファイルを指定します。

基本：

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser open https://example.com`

検査：

- `openclaw browser screenshot`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser console --level error`
- `openclaw browser pdf`

アクション：

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`

状態：

- `openclaw browser cookies`
- `openclaw browser storage local get`
- `openclaw browser set offline on`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set device "iPhone 14"`

## エージェントツール + コントロールの仕組み

エージェントはブラウザ自動化のために**1つのツール**を取得します：

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

このツールは以下を受け付けます：

- `profile` で名前付きブラウザプロファイルを選択（openclaw、chrome、またはリモート CDP）。
- `target`（`sandbox` | `host` | `node`）でブラウザが存在する場所を選択。

## 関連

- [ツール概要](/tools) — 利用可能なすべてのエージェントツール
- [サンドボックス](/gateway/sandboxing) — サンドボックス環境でのブラウザコントロール
- [セキュリティ](/gateway/security) — ブラウザコントロールのリスクとハードニング
