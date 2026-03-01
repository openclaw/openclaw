---
summary: "統合ブラウザコントロールサービス + アクションコマンド"
read_when:
  - エージェントによるブラウザオートメーションの追加時
  - openclawが自分のChromeに干渉する理由のデバッグ時
  - macOSアプリでのブラウザ設定とライフサイクルの実装時
title: "ブラウザ（OpenClaw管理）"
---

# ブラウザ（openclaw管理）

OpenClawはエージェントが制御する**専用のChrome/Brave/Edge/Chromiumプロファイル**を実行できます。
これはあなたの個人ブラウザから隔離されており、Gateway内の小さなローカルコントロールサービス（ループバックのみ）を通じて管理されます。

初心者向け説明:

- **エージェント専用のブラウザ**として考えてください。
- `openclaw` プロファイルはあなたの個人ブラウザプロファイルには**触れません**。
- エージェントは安全なレーンでタブを開き、ページを読み、クリックし、入力できます。
- デフォルトの `chrome` プロファイルは、エクステンションリレー経由で**システムデフォルトのChromiumブラウザ**を使用します。隔離されたマネージドブラウザには `openclaw` に切り替えてください。

## 提供される機能

- **openclaw** という名前の別ブラウザプロファイル（デフォルトでオレンジアクセント）。
- 決定論的なタブコントロール（リスト/開く/フォーカス/閉じる）。
- エージェントアクション（クリック/入力/ドラッグ/選択）、スナップショット、スクリーンショット、PDF。
- オプションのマルチプロファイルサポート（`openclaw`、`work`、`remote`など）。

このブラウザは日常的なブラウザではありません。エージェントのオートメーションと検証のための安全で隔離されたサーフェスです。

## クイックスタート

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

「Browser disabled」と表示された場合は、設定でブラウザを有効にして（以下参照）、Gatewayを再起動してください。

## プロファイル: `openclaw` vs `chrome`

- `openclaw`: マネージドで隔離されたブラウザ（エクステンション不要）。
- `chrome`: **システムブラウザ**へのエクステンションリレー（タブにアタッチされたOpenClawエクステンションが必要）。

デフォルトでマネージドモードを使用したい場合は `browser.defaultProfile: "openclaw"` を設定してください。

## 設定

ブラウザ設定は `~/.openclaw/openclaw.json` にあります。

```json5
{
  browser: {
    enabled: true, // デフォルト: true
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true, // デフォルトの信頼ネットワークモード
      // allowPrivateNetwork: true, // レガシーエイリアス
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    // cdpUrl: "http://127.0.0.1:18792", // レガシーシングルプロファイルオーバーライド
    remoteCdpTimeoutMs: 1500, // リモートCDP HTTPタイムアウト（ms）
    remoteCdpHandshakeTimeoutMs: 3000, // リモートCDP WebSocketハンドシェイクタイムアウト（ms）
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

注意事項:

- ブラウザコントロールサービスは `gateway.port` から導出されたポートのループバックにバインドします（デフォルト: `18791`、つまりgateway + 2）。リレーは次のポート（`18792`）を使用します。
- Gatewayポートをオーバーライドする場合（`gateway.port` または `OPENCLAW_GATEWAY_PORT`）、派生したブラウザポートは同じ「ファミリー」に留まるようにシフトします。
- `cdpUrl` は未設定の場合、リレーポートのデフォルトになります。
- `remoteCdpTimeoutMs` はリモート（ループバック以外）CDP到達可能性チェックに適用されます。
- `remoteCdpHandshakeTimeoutMs` はリモートCDP WebSocket到達可能性チェックに適用されます。
- ブラウザのナビゲーション/タブを開く操作は、ナビゲーション前にSSRFガードが行われ、ナビゲーション後の最終的な `http(s)` URLについてベストエフォートで再チェックされます。
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` はデフォルトで `true`（信頼ネットワークモデル）です。厳格なパブリックのみのブラウジングには `false` に設定してください。
- `browser.ssrfPolicy.allowPrivateNetwork` は互換性のためのレガシーエイリアスとして引き続きサポートされています。
- `attachOnly: true` は「ローカルブラウザを起動しない。すでに実行中の場合のみアタッチする」を意味します。
- `color` とプロファイルごとの `color` はブラウザUIを着色し、どのプロファイルがアクティブかを確認できます。
- デフォルトプロファイルは `chrome`（エクステンションリレー）です。マネージドブラウザには `defaultProfile: "openclaw"` を使用してください。
- 自動検出順序: システムデフォルトブラウザがChromiumベースの場合; それ以外はChrome → Brave → Edge → Chromium → Chrome Canary。
- ローカルの `openclaw` プロファイルは `cdpPort`/`cdpUrl` を自動割り当てします。リモートCDP用にのみそれらを設定してください。

## Brave（または他のChromiumベースブラウザ）を使用する

**システムデフォルト**ブラウザがChromiumベース（Chrome/Brave/Edgeなど）の場合、OpenClawは自動的にそれを使用します。自動検出をオーバーライドするには `browser.executablePath` を設定してください:

CLIの例:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## ローカルとリモートコントロール

- **ローカルコントロール（デフォルト）:** Gatewayがループバックコントロールサービスを起動し、ローカルブラウザを起動できます。
- **リモートコントロール（ノードホスト）:** ブラウザを持つマシンでノードホストを実行します。Gatewayはブラウザアクションをそのノードにプロキシします。
- **リモートCDP:** `browser.profiles.<name>.cdpUrl`（または `browser.cdpUrl`）を設定して、リモートのChromiumベースブラウザにアタッチします。この場合、OpenClawはローカルブラウザを起動しません。

リモートCDP URLには認証を含められます:

- クエリトークン（例: `https://provider.example?token=<token>`）
- HTTP基本認証（例: `https://user:pass@provider.example`）

OpenClawは `/json/*` エンドポイントの呼び出し時とCDP WebSocketへの接続時に認証を保持します。トークンをコンフィグファイルにコミットするのではなく、環境変数やシークレットマネージャーを優先してください。

## ノードブラウザプロキシ（ゼロ設定デフォルト）

ブラウザを持つマシンで**ノードホスト**を実行する場合、OpenClawは追加のブラウザ設定なしにブラウザツール呼び出しをそのノードに自動ルーティングできます。これはリモートゲートウェイのデフォルトパスです。

注意事項:

- ノードホストは**プロキシコマンド**を通じてローカルブラウザコントロールサーバーを公開します。
- プロファイルはノード自身の `browser.profiles` 設定から取得します（ローカルと同じ）。
- 無効にする場合:
  - ノード上: `nodeHost.browserProxy.enabled=false`
  - ゲートウェイ上: `gateway.nodes.browser.mode="off"`

## Browserless（ホスト型リモートCDP）

[Browserless](https://browserless.io) はHTTPS経由でCDPエンドポイントを公開するホスト型Chromiumサービスです。OpenClawブラウザプロファイルをBrowserlessのリージョンエンドポイントに向け、APIキーで認証できます。

例:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

注意事項:

- `<BROWSERLESS_API_KEY>` を実際のBrowserlessトークンに置き換えてください。
- Browserlessアカウントに合ったリージョンエンドポイントを選択してください（詳細はBrowserlessのドキュメントを参照）。

## セキュリティ

主なポイント:

- ブラウザコントロールはループバック専用です。アクセスはGatewayの認証またはノードペアリングを経由します。
- ブラウザコントロールが有効で認証が設定されていない場合、OpenClawは起動時に `gateway.auth.token` を自動生成してコンフィグに保存します。
- Gatewayとノードホストをプライベートネットワーク（Tailscale）上に置いてください。パブリック公開は避けてください。
- リモートCDP URLとトークンはシークレットとして扱ってください。環境変数またはシークレットマネージャーを優先してください。

リモートCDPのヒント:

- 可能な場合はHTTPSエンドポイントと短命のトークンを優先してください。
- 長命のトークンをコンフィグファイルに直接埋め込まないでください。

## プロファイル（マルチブラウザ）

OpenClawは複数の名前付きプロファイル（ルーティング設定）をサポートしています。プロファイルは以下のいずれかになります:

- **openclaw管理**: 専用のユーザーデータディレクトリとCDPポートを持つChromiumベースのブラウザインスタンス
- **リモート**: 明示的なCDP URL（他の場所で実行されているChromiumベースのブラウザ）
- **エクステンションリレー**: ローカルリレーとChromeエクステンション経由の既存のChromeタブ

デフォルト:

- `openclaw` プロファイルが欠落している場合は自動作成されます。
- `chrome` プロファイルはChromeエクステンションリレー用に組み込まれています（デフォルトで `http://127.0.0.1:18792` を指します）。
- ローカルCDPポートはデフォルトで **18800-18899** から割り当てられます。
- プロファイルを削除すると、そのローカルデータディレクトリがゴミ箱に移動されます。

すべてのコントロールエンドポイントは `?profile=<name>` を受け付けます。CLIは `--browser-profile` を使用します。

## Chromeエクステンションリレー（既存のChromeを使用する）

OpenClawはローカルCDPリレーとChromeエクステンションを通じて、**既存のChromeタブ**も制御できます（別の「openclaw」Chromeインスタンスは不要）。

完全なガイド: [Chromeエクステンション](/tools/chrome-extension)

フロー:

- Gatewayはローカル（同じマシン）で実行されるか、ブラウザマシンでノードホストが実行されます。
- ローカル**リレーサーバー**はループバックの `cdpUrl` でリッスンします（デフォルト: `http://127.0.0.1:18792`）。
- タブで**OpenClaw Browser Relay**エクステンションアイコンをクリックしてアタッチします（自動アタッチはしません）。
- エージェントは正しいプロファイルを選択することで、通常の `browser` ツールを通じてそのタブを制御します。

Gatewayが他の場所で実行されている場合は、ブラウザマシンでノードホストを実行して、Gatewayがブラウザアクションをプロキシできるようにしてください。

### サンドボックス化されたセッション

エージェントセッションがサンドボックス化されている場合、`browser` ツールはデフォルトで `target="sandbox"`（サンドボックスブラウザ）になる場合があります。
Chromeエクステンションリレーの引き継ぎにはホストブラウザコントロールが必要なため、以下のいずれかを行ってください:

- サンドボックス化されていないセッションを実行する、または
- `agents.defaults.sandbox.browser.allowHostControl: true` を設定してツール呼び出し時に `target="host"` を使用する。

### セットアップ

1. エクステンションをロードします（開発/アンパック）:

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 「デベロッパーモード」を有効にする
- 「パッケージ化されていない拡張機能を読み込む」→ `openclaw browser extension path` で表示されたディレクトリを選択
- エクステンションをピン留めし、コントロールしたいタブでクリックします（バッジに `ON` と表示）。

2. 使用方法:

- CLI: `openclaw browser --browser-profile chrome tabs`
- エージェントツール: `profile="chrome"` で `browser` を使用

オプション: 別の名前やリレーポートを使用したい場合は、独自のプロファイルを作成してください:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

注意事項:

- このモードはほとんどの操作（スクリーンショット/スナップショット/アクション）でPlaywright-on-CDPに依存します。
- エクステンションアイコンを再度クリックしてデタッチします。

## 隔離の保証

- **専用ユーザーデータディレクトリ**: 個人のブラウザプロファイルには触れません。
- **専用ポート**: 開発ワークフローとの衝突を防ぐため `9222` を避けます。
- **決定論的タブコントロール**: 「最後のタブ」ではなく `targetId` でタブをターゲットにします。

## ブラウザ選択

ローカルで起動する場合、OpenClawは最初に利用可能なものを選びます:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath` でオーバーライドできます。

プラットフォーム:

- macOS: `/Applications` と `~/Applications` を確認します。
- Linux: `google-chrome`、`brave`、`microsoft-edge`、`chromium` などを探します。
- Windows: 一般的なインストール場所を確認します。

## コントロールAPI（オプション）

ローカル統合のみを対象として、GatewayはループバックHTTP APIを公開しています:

- ステータス/起動/停止: `GET /`, `POST /start`, `POST /stop`
- タブ: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- スナップショット/スクリーンショット: `GET /snapshot`, `POST /screenshot`
- アクション: `POST /navigate`, `POST /act`
- フック: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- ダウンロード: `POST /download`, `POST /wait/download`
- デバッグ: `GET /console`, `POST /pdf`
- デバッグ: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- ネットワーク: `POST /response/body`
- 状態: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- 状態: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- 設定: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

すべてのエンドポイントは `?profile=<name>` を受け付けます。

ゲートウェイ認証が設定されている場合、ブラウザHTTPルートも認証を要求します:

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` またはそのパスワードを使用したHTTP基本認証

### Playwrightの要件

一部の機能（navigate/act/AIスナップショット/ロールスナップショット、要素スクリーンショット、PDF）にはPlaywrightが必要です。Playwrightがインストールされていない場合、これらのエンドポイントは明確な501エラーを返します。ARIAスナップショットと基本的なスクリーンショットはopenclaw管理のChromeでも引き続き機能します。Chromeエクステンションリレードライバーでは、ARIAスナップショットとスクリーンショットにPlaywrightが必要です。

「Playwright is not available in this gateway build」と表示された場合は、フルのPlaywrightパッケージ（`playwright-core` ではなく）をインストールしてゲートウェイを再起動するか、ブラウザサポートつきでOpenClawを再インストールしてください。

#### Docker Playwrightインストール

GatewayがDockerで実行されている場合、`npx playwright` を避けてください（npmオーバーライドの競合）。代わりにバンドルされたCLIを使用してください:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

ブラウザのダウンロードを永続化するには、`PLAYWRIGHT_BROWSERS_PATH`（例: `/home/node/.cache/ms-playwright`）を設定し、`/home/node` が `OPENCLAW_HOME_VOLUME` またはバインドマウントで永続化されることを確認してください。[Docker](/install/docker) を参照してください。

## 仕組み（内部）

ハイレベルフロー:

- 小さな**コントロールサーバー**がHTTPリクエストを受け付けます。
- **CDP**を通じてChromiumベースのブラウザ（Chrome/Brave/Edge/Chromium）に接続します。
- 高度なアクション（クリック/入力/スナップショット/PDF）には、CDPの上で**Playwright**を使用します。
- Playwrightが欠落している場合、Playwright不要の操作のみが利用可能です。

この設計により、エージェントは安定した決定論的インターフェースに留まりながら、ローカル/リモートブラウザとプロファイルを切り替えられます。

## CLIクイックリファレンス

すべてのコマンドは `--browser-profile <name>` で特定のプロファイルをターゲットにできます。
すべてのコマンドは `--json` でマシン可読な出力（安定したペイロード）も受け付けます。

基本:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

検査:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

アクション:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 report.pdf`
- `openclaw browser waitfordownload report.pdf`
- `openclaw browser upload /tmp/openclaw/uploads/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

状態:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --headers-json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

注意事項:

- `upload` と `dialog` は**アーミング**呼び出しです。ファイル選択ダイアログ/ダイアログをトリガーするクリック/押下の前に実行してください。
- ダウンロードとトレースの出力パスはOpenClawのtempルートに制限されます:
  - トレース: `/tmp/openclaw`（フォールバック: `${os.tmpdir()}/openclaw`）
  - ダウンロード: `/tmp/openclaw/downloads`（フォールバック: `${os.tmpdir()}/openclaw/downloads`）
- アップロードパスはOpenClawのtempアップロードルートに制限されます:
  - アップロード: `/tmp/openclaw/uploads`（フォールバック: `${os.tmpdir()}/openclaw/uploads`）
- `upload` は `--input-ref` または `--element` でファイル入力を直接設定することもできます。
- `snapshot`:
  - `--format ai`（Playwrightがインストールされている場合のデフォルト）: 数値参照付きのAIスナップショットを返します（`aria-ref="<n>"`）。
  - `--format aria`: アクセシビリティツリーを返します（参照なし、検査のみ）。
  - `--efficient`（または `--mode efficient`）: コンパクトなロールスナップショットプリセット（インタラクティブ + コンパクト + 深さ + 低maxChars）。
  - 設定デフォルト（ツール/CLIのみ）: 呼び出し元がモードを渡さない場合に効率的なスナップショットを使用するには `browser.snapshotDefaults.mode: "efficient"` を設定します（[Gateway設定](/gateway/configuration#browser-openclaw-managed-browser) を参照）。
  - ロールスナップショットオプション（`--interactive`、`--compact`、`--depth`、`--selector`）は `ref=e12` のような参照でロールベースのスナップショットを強制します。
  - `--frame "<iframe selector>"` でロールスナップショットをiframeにスコープします（`e12` のようなロール参照とペア）。
  - `--interactive` はインタラクティブな要素のフラットで選びやすいリストを出力します（アクション実行に最適）。
  - `--labels` はオーバーレイした参照ラベルつきのビューポートのみのスクリーンショットを追加します（`MEDIA:<path>` を出力）。
- `click`/`type` などには `snapshot` からの `ref` が必要です（数値の `12` またはロール参照の `e12`）。
  CSSセレクターはアクションでは意図的にサポートされていません。

## スナップショットと参照

OpenClawは2つの「スナップショット」スタイルをサポートしています:

- **AIスナップショット（数値参照）**: `openclaw browser snapshot`（デフォルト; `--format ai`）
  - 出力: 数値参照を含むテキストスナップショット。
  - アクション: `openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 内部的には参照はPlaywrightの `aria-ref` を通じて解決されます。

- **ロールスナップショット（`e12` のようなロール参照）**: `openclaw browser snapshot --interactive`（または `--compact`、`--depth`、`--selector`、`--frame`）
  - 出力: `[ref=e12]`（およびオプションの `[nth=1]`）を含むロールベースのリスト/ツリー。
  - アクション: `openclaw browser click e12`、`openclaw browser highlight e12`。
  - 内部的には参照は `getByRole(...)` を通じて解決されます（重複には `nth()` を追加）。
  - `--labels` でビューポートのスクリーンショットにオーバーレイした `e12` ラベルを含められます。

参照の動作:

- 参照はナビゲーション間で**安定していません**。何かが失敗した場合は、`snapshot` を再実行して新しい参照を使用してください。
- ロールスナップショットが `--frame` で取得された場合、ロール参照は次のロールスナップショットまでそのiframeにスコープされます。

## Waitのパワーアップ

時間/テキスト以上のものを待機できます:

- URLを待機します（PlaywrightがサポートするGlobが使えます）:
  - `openclaw browser wait --url "**/dash"`
- ロード状態を待機します:
  - `openclaw browser wait --load networkidle`
- JS述語を待機します:
  - `openclaw browser wait --fn "window.ready===true"`
- セレクターが表示されるまで待機します:
  - `openclaw browser wait "#main"`

これらを組み合わせられます:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## デバッグワークフロー

アクションが失敗した場合（例: 「not visible」、「strict mode violation」、「covered」）:

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` を使用します（インタラクティブモードではロール参照を優先）
3. まだ失敗する場合: `openclaw browser highlight <ref>` でPlaywrightがターゲットにしているものを確認
4. ページの動作がおかしい場合:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 詳細デバッグ: トレースを記録する:
   - `openclaw browser trace start`
   - 問題を再現する
   - `openclaw browser trace stop`（`TRACE:<path>` を出力）

## JSON出力

`--json` はスクリプティングと構造化ツール向けです。

例:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON内のロールスナップショットには `refs` と小さな `stats` ブロック（行数/文字数/参照数/インタラクティブ数）が含まれており、ツールがペイロードサイズと密度を把握できます。

## 状態と環境の設定

「サイトをXのように動作させる」ワークフローに役立ちます:

- Cookie: `cookies`、`cookies set`、`cookies clear`
- ストレージ: `storage local|session get|set|clear`
- オフライン: `set offline on|off`
- ヘッダー: `set headers --headers-json '{"X-Debug":"1"}'`（レガシーの `set headers --json '{"X-Debug":"1"}'` も引き続きサポート）
- HTTP基本認証: `set credentials user pass`（または `--clear`）
- 位置情報: `set geo <lat> <lon> --origin "https://example.com"`（または `--clear`）
- メディア: `set media dark|light|no-preference|none`
- タイムゾーン/ロケール: `set timezone ...`、`set locale ...`
- デバイス/ビューポート:
  - `set device "iPhone 14"`（Playwrightデバイスプリセット）
  - `set viewport 1280 720`

## セキュリティとプライバシー

- openclawブラウザプロファイルにはログイン済みセッションが含まれる場合があります。機密情報として扱ってください。
- `browser act kind=evaluate` / `openclaw browser evaluate` と `wait --fn` はページコンテキストで任意のJavaScriptを実行します。プロンプトインジェクションでこれを誘導される可能性があります。不要な場合は `browser.evaluateEnabled=false` で無効化してください。
- ログインとボット対策のメモ（X/Twitterなど）については、[ブラウザログイン + X/Twitter投稿](/tools/browser-login) を参照してください。
- Gateway/ノードホストをプライベートに保ってください（ループバックまたはtailnetのみ）。
- リモートCDPエンドポイントは強力です。トンネルで保護してください。

厳格モードの例（デフォルトでプライベート/内部デスティネーションをブロック）:

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"], // オプションの完全一致許可
    },
  },
}
```

## トラブルシューティング

Linuxに固有の問題（特にsnap Chromium）については、[ブラウザトラブルシューティング](/tools/browser-linux-troubleshooting) を参照してください。

## エージェントツールとコントロールの仕組み

エージェントはブラウザオートメーション用に**1つのツール**を取得します:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

マッピング方法:

- `browser snapshot` は安定したUIツリー（AIまたはARIA）を返します。
- `browser act` はスナップショットの `ref` IDを使用してクリック/入力/ドラッグ/選択を行います。
- `browser screenshot` はピクセルをキャプチャします（全ページまたは要素）。
- `browser` は以下を受け付けます:
  - `profile` で名前付きブラウザプロファイル（openclaw、chrome、またはリモートCDP）を選択します。
  - `target`（`sandbox` | `host` | `node`）でブラウザがどこに存在するかを選択します。
  - サンドボックス化されたセッションでは、`target: "host"` に `agents.defaults.sandbox.browser.allowHostControl=true` が必要です。
  - `target` が省略された場合: サンドボックス化されたセッションはデフォルトで `sandbox`、非サンドボックスセッションはデフォルトで `host` になります。
  - ブラウザ対応ノードが接続されている場合、`target="host"` または `target="node"` をピンしない限り、ツールはそのノードに自動ルーティングされる場合があります。

これにより、エージェントは決定論的に動作し、脆弱なセレクターを避けられます。
