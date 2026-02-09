---
summary: "統合ブラウザー制御サービス + アクションコマンド"
read_when:
  - エージェント制御のブラウザー自動化を追加する場合
  - openclaw が自身の Chrome に干渉している理由をデバッグする場合
  - macOS アプリでブラウザー設定およびライフサイクルを実装する場合
title: "Browser（OpenClaw 管理）"
---

# Browser（openclaw 管理）

OpenClaw は、エージェントが制御する **専用の Chrome/Brave/Edge/Chromium プロファイル** を実行できます。
これは個人用ブラウザーから分離されており、Gateway（ゲートウェイ）内の小さなローカル
制御サービス（local loopback のみ）を通じて管理されます。
個人用ブラウザから分離され、ゲートウェイ内の小さなローカル
制御サービスを通じて管理されます(ループバックのみ)。

初心者向けの見方：

- **エージェント専用の別ブラウザー** と考えてください。
- `openclaw` プロファイルは、個人用ブラウザープロファイルに **一切触れません**。
- エージェントは、安全なレーンで **タブを開く、ページを読む、クリック、入力** ができます。
- 既定の `chrome` プロファイルは、拡張機能リレー経由で **システム既定の Chromium ブラウザー** を使用します。
  分離された管理対象ブラウザーに切り替えるには `openclaw` を使用します。

## あなたが得るもの

- **openclaw** という名前の独立したブラウザープロファイル（既定ではオレンジのアクセント）。
- 決定論的なタブ制御（一覧／オープン／フォーカス／クローズ）。
- エージェントアクション（クリック／入力／ドラッグ／選択）、スナップショット、スクリーンショット、PDF。
- オプションのマルチプロファイル対応（`openclaw`、`work`、`remote`、…）。

このブラウザーは毎日のドライバーではありません。 これは、
エージェントの自動化と検証のための安全で孤立した表面です。

## クイックスタート

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

「Browser disabled」と表示された場合は、設定で有効化（下記参照）して Gateway を再起動してください。

## プロファイル：`openclaw` vs `chrome`

- `openclaw`：管理対象の分離ブラウザー（拡張機能不要）。
- `chrome`：**システムブラウザー** への拡張機能リレー（OpenClaw
  拡張機能をタブにアタッチする必要があります）。

既定で管理モードにしたい場合は `browser.defaultProfile: "openclaw"` を設定します。

## 設定

ブラウザー設定は `~/.openclaw/openclaw.json` にあります。

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
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

注記：

- ブラウザー制御サービスは、`gateway.port` から導出されたポートで loopback にバインドされます
  （既定：`18791`。gateway + 2）。リレーは次のポート（`18792`）を使用します。 リレーは次のポート (`18792`) を使用します。
- Gateway ポート（`gateway.port` または `OPENCLAW_GATEWAY_PORT`）を上書きすると、
  派生するブラウザーポートも同じ「ファミリー」を保つようにシフトします。
- `cdpUrl` は未設定時、既定でリレーポートになります。
- `remoteCdpTimeoutMs` はリモート（非 loopback）の CDP 到達性チェックに適用されます。
- `remoteCdpHandshakeTimeoutMs` はリモート CDP WebSocket の到達性チェックに適用されます。
- `attachOnly: true` は「ローカルブラウザーを起動しない。既に実行中の場合のみアタッチする」を意味します。
- `color` と各プロファイルの `color` により、どのプロファイルがアクティブか分かるように
  ブラウザー UI を着色します。
- 既定プロファイルは `chrome`（拡張機能リレー）です。管理対象ブラウザーには `defaultProfile: "openclaw"` を使用します。 管理されたブラウザに `defaultProfile: "openclaw"`を使用します。
- 自動検出の順序：Chromium ベースのシステム既定ブラウザー、そうでなければ
  Chrome → Brave → Edge → Chromium → Chrome Canary。
- ローカルの `openclaw` プロファイルは `cdpPort`/`cdpUrl` を自動割り当てします。
  これらはリモート CDP の場合のみ設定してください。

## Brave（または他の Chromium ベース）を使用する

**システム既定** のブラウザーが Chromium ベース（Chrome/Brave/Edge など）の場合、
OpenClaw は自動的にそれを使用します。自動検出を上書きするには `browser.executablePath` を設定します。 `browser.executablePath` を
自動検出を上書きするように設定します:

CLI の例：

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

## ローカル制御 vs リモート制御

- **ローカル制御（既定）**：Gateway が loopback 制御サービスを起動し、ローカルブラウザーを起動できます。
- **リモート制御（node host）**：ブラウザーがあるマシンで node host を実行し、Gateway がブラウザー操作をプロキシします。
- **リモート CDP**：`browser.profiles.<name>.cdpUrl`（または `browser.cdpUrl`）を設定して、
  リモートの Chromium ベースブラウザーにアタッチします。この場合、OpenClaw はローカルブラウザーを起動しません。 この場合、OpenClawはローカルブラウザを起動しません。

リモート CDP の URL には認証を含めることができます：

- クエリトークン（例：`https://provider.example?token=<token>`）
- HTTP Basic 認証（例：`https://user:pass@provider.example`）

OpenClaw は、`/json/*` エンドポイントの呼び出し時および
CDP WebSocket 接続時に認証を保持します。
トークンは設定ファイルにコミットするのではなく、環境変数やシークレットマネージャーを使用してください。 設定ファイルにコミットするのではなく、
トークンの環境変数やシークレットマネージャを優先します。

## Node ブラウザープロキシ（ゼロ設定の既定）

ブラウザーがあるマシンで **node host** を実行している場合、OpenClaw は追加のブラウザー設定なしで
ブラウザーツール呼び出しをその node に自動ルーティングできます。
これはリモート Gateway の既定パスです。
これは、リモートゲートウェイのデフォルトのパスです。

注記：

- node host は **プロキシコマンド** を介してローカルのブラウザー制御サーバーを公開します。
- プロファイルは node 自身の `browser.profiles` 設定（ローカルと同じ）から取得されます。
- 不要な場合は無効化できます：
  - node 側：`nodeHost.browserProxy.enabled=false`
  - gateway 側：`gateway.nodes.browser.mode="off"`

## Browserless（ホスト型リモート CDP）

[Browserless](https://browserless.io) は、HTTPS 経由で CDP エンドポイントを公開する
ホスト型 Chromium サービスです。OpenClaw のブラウザープロファイルを
Browserless のリージョンエンドポイントに向け、API キーで認証できます。 OpenClawブラウザプロファイルを
ブラウザレスリージョンエンドポイントで指定し、APIキーで認証することができます。

例：

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

注記：

- `<BROWSERLESS_API_KEY>` を実際の Browserless トークンに置き換えてください。
- Browserless アカウントに対応するリージョンエンドポイントを選択してください（詳細は同社ドキュメント参照）。

## セキュリティ

主なアイデア:

- ブラウザー制御は loopback のみです。アクセスは Gateway の認証または node のペアリングを通じて行われます。
- Gateway および node host はプライベートネットワーク（Tailscale）上に保ち、公開露出を避けてください。
- リモートの CDP URL/トークンをシークレットとして扱います。

リモート CDP のヒント：

- 可能であれば HTTPS エンドポイントと短命トークンを使用してください。
- 長命トークンを設定ファイルに直接埋め込まないでください。

## プロファイル（マルチブラウザー）

OpenClaw は、複数の名前付きプロファイル（ルーティング設定）をサポートします。プロファイルは次のいずれかです： プロファイルは次のようになります:

- **openclaw-managed**：独自のユーザーデータディレクトリと CDP ポートを持つ専用の Chromium ベースブラウザー
- **remote**：明示的な CDP URL（別所で稼働する Chromium ベースブラウザー）
- **extension relay**：ローカルリレー + Chrome 拡張機能を介した既存の Chrome タブ

既定：

- `openclaw` プロファイルは、存在しない場合に自動作成されます。
- `chrome` プロファイルは、Chrome 拡張機能リレー用に組み込みで提供されます
  （既定では `http://127.0.0.1:18792` を指します）。
- ローカル CDP ポートは既定で **18800–18899** から割り当てられます。
- プロファイルを削除すると、ローカルのデータディレクトリはゴミ箱に移動されます。

すべての制御エンドポイントは `?profile=<name>` を受け付けます。CLI は `--browser-profile` を使用します。

## Chrome 拡張機能リレー（既存の Chrome を使用）

OpenClaw は、ローカル CDP リレー + Chrome 拡張機能を介して、
**既存の Chrome タブ** を制御することもできます
（別の「openclaw」Chrome インスタンスは不要）。

完全ガイド：[Chrome extension](/tools/chrome-extension)

フロー：

- Gateway をローカル（同一マシン）で実行するか、ブラウザーマシンで node host を実行します。
- ローカルの **リレーサーバー** が loopback の `cdpUrl`（既定：`http://127.0.0.1:18792`）で待ち受けます。
- 制御したいタブで **OpenClaw Browser Relay** 拡張機能アイコンをクリックしてアタッチします
  （自動アタッチはされません）。
- エージェントは、正しいプロファイルを選択することで、通常の `browser` ツール経由でそのタブを制御します。

Gateway が別の場所で実行されている場合は、ブラウザーマシンで node host を実行し、
Gateway がブラウザー操作をプロキシできるようにしてください。

### サンドボックス化されたセッション

エージェントセッションがサンドボックス化されている場合、`browser` ツールは
既定で `target="sandbox"`（サンドボックスブラウザー）になることがあります。
Chrome 拡張機能リレーの引き継ぎにはホストブラウザー制御が必要なため、次のいずれかを行ってください：
Chrome拡張リレーの乗っ取りにはホストブラウザの制御が必要なので、以下のいずれかが必要です:

- セッションを非サンドボックスで実行する、または
- `agents.defaults.sandbox.browser.allowHostControl: true` を設定し、ツール呼び出し時に `target="host"` を使用する。

### セットアップ

1. 拡張機能を読み込む（dev／unpacked）：

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 「Developer mode」を有効化
- 「Load unpacked」→ `openclaw browser extension path` が出力したディレクトリを選択
- 拡張機能をピン留めし、制御したいタブでクリックします（バッジに `ON` が表示されます）。

2. 使用する：

- CLI：`openclaw browser --browser-profile chrome tabs`
- エージェントツール：`browser`（`profile="chrome"` を指定）

オプション：別の名前やリレーポートを使いたい場合は、独自のプロファイルを作成します：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

注記：

- このモードは、ほとんどの操作（スクリーンショット／スナップショット／アクション）で
  Playwright-on-CDP に依存します。
- 切断するには、拡張機能アイコンを再度クリックします。

## 分離の保証

- **専用ユーザーデータディレクトリ**：個人用ブラウザープロファイルに触れません。
- **専用ポート**：開発ワークフローとの衝突を防ぐため、`9222` を回避します。
- **決定論的なタブ制御**：「最後のタブ」ではなく、`targetId` でタブを指定します。

## ブラウザー選択

ローカル起動時、OpenClaw は次の順で利用可能なものを選択します：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath` で上書きできます。

プラットフォーム：

- macOS：`/Applications` と `~/Applications` を確認します。
- Linux：`google-chrome`、`brave`、`microsoft-edge`、`chromium` などを探します。
- Windows：一般的なインストール場所を確認します。

## Control API（任意）

ローカル統合専用として、Gateway は小さな loopback HTTP API を公開します：

- ステータス／開始／停止：`GET /`、`POST /start`、`POST /stop`
- タブ：`GET /tabs`、`POST /tabs/open`、`POST /tabs/focus`、`DELETE /tabs/:targetId`
- スナップショット／スクリーンショット：`GET /snapshot`、`POST /screenshot`
- アクション：`POST /navigate`、`POST /act`
- フック：`POST /hooks/file-chooser`、`POST /hooks/dialog`
- ダウンロード：`POST /download`、`POST /wait/download`
- デバッグ：`GET /console`、`POST /pdf`
- デバッグ：`GET /errors`、`GET /requests`、`POST /trace/start`、`POST /trace/stop`、`POST /highlight`
- ネットワーク：`POST /response/body`
- 状態：`GET /cookies`、`POST /cookies/set`、`POST /cookies/clear`
- 状態：`GET /storage/:kind`、`POST /storage/:kind/set`、`POST /storage/:kind/clear`
- 設定：`POST /set/offline`、`POST /set/headers`、`POST /set/credentials`、`POST /set/geolocation`、`POST /set/media`、`POST /set/timezone`、`POST /set/locale`、`POST /set/device`

すべてのエンドポイントは `?profile=<name>` を受け付けます。

### Playwright の要件

いくつかの機能 (ナビゲーション/アクト/AIスナップショット/ロールスナップショット、要素スクリーンショット、PDF)
Playwrightが必要です。 Playwrightがインストールされていない場合、それらのエンドポイントはクリア501
エラーを返します。 ARIAのスナップショットと基本的なスクリーンショットは、まだオープンクロー管理Chromeで動作します。
Chrome拡張リレードライバの場合、ARIAスナップショットとスクリーンショットにはPlaywrightが必要です。

`Playwright is not available in this gateway build` が表示された場合は、完全な
Playwright パッケージ（`playwright-core` ではありません）をインストールして Gateway を再起動するか、
ブラウザー対応で OpenClaw を再インストールしてください。

#### Docker での Playwright インストール

Gateway を Docker で実行している場合は、`npx playwright`（npm の上書き競合）を避けてください。
同梱の CLI を使用します：
代わりにバンドルされた CLI を使用します。

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

ブラウザーのダウンロードを永続化するには、`PLAYWRIGHT_BROWSERS_PATH`（例：`/home/node/.cache/ms-playwright`）を設定し、
`/home/node` が `OPENCLAW_HOME_VOLUME` または bind mount により永続化されていることを確認してください。
[Docker](/install/docker) を参照してください。 [Docker](/install/docker) を参照してください。

## 仕組み（内部）

高レベルのフロー：

- 小さな **制御サーバー** が HTTP リクエストを受け付けます。
- **CDP** を介して Chromium ベースのブラウザー（Chrome/Brave/Edge/Chromium）に接続します。
- 高度な操作（クリック／入力／スナップショット／PDF）には、
  CDP の上に **Playwright** を使用します。
- Playwright がない場合は、非 Playwright の操作のみ利用可能です。

この設計により、エージェントは安定した決定論的インターフェースを保ちながら、
ローカル／リモートのブラウザーやプロファイルを切り替えられます。

## CLI クイックリファレンス

すべてのコマンドは `--browser-profile <name>` を特定のプロファイルをターゲットにします。
すべてのコマンドは、特定のプロファイルを指定するために `--browser-profile <name>` を受け付けます。
また、機械可読出力（安定したペイロード）のために `--json` も受け付けます。

基本：

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

検査：

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

アクション：

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
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

状態：

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

注記：

- `upload` と `dialog` は **アーミング** 呼び出しです。選択ダイアログを
  トリガーするクリック／キー押下の前に実行してください。
- `upload` は、`--input-ref` または `--element` により
  ファイル入力を直接設定することもできます。
- `snapshot`：
  - `--format ai`（Playwright がインストールされている場合の既定）：
    数値参照（`aria-ref="<n>"`）付きの AI スナップショットを返します。
  - `--format aria`：アクセシビリティツリーを返します（参照なし、検査のみ）。
  - `--efficient`（または `--mode efficient`）：
    コンパクトなロールスナップショットのプリセット（インタラクティブ + コンパクト + 深さ + 低い maxChars）。
  - 設定の既定（ツール／CLI のみ）：
    呼び出し側がモードを渡さない場合に効率的なスナップショットを使うには
    `browser.snapshotDefaults.mode: "efficient"` を設定します（[Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser) を参照）。
  - ロールスナップショットのオプション（`--interactive`、`--compact`、`--depth`、`--selector`）は、
    `ref=e12` のような参照を持つロールベースのスナップショットを強制します。
  - `--frame "<iframe selector>"` は、ロールスナップショットを iframe にスコープします
    （`e12` のようなロール参照と組み合わせます）。
  - `--interactive` は、操作に最適なフラットで選びやすいインタラクティブ要素一覧を出力します。
  - `--labels` は、参照ラベルをオーバーレイしたビューポート限定のスクリーンショットを追加します
    （`MEDIA:<path>` を出力）。
- `click`/`type`/ などは、`snapshot` から取得した `ref`
  （数値の `12` またはロール参照の `e12`）が必要です。
  CSS セレクターは意図的にアクションではサポートされていません。
  CSS セレクターは意図的にアクションに対してサポートされていません。

## スナップショットと参照

OpenClaw は 2 種類の「スナップショット」スタイルをサポートします：

- **AI スナップショット（数値参照）**：`openclaw browser snapshot`（既定；`--format ai`）
  - 出力：数値参照を含むテキストスナップショット。
  - アクション：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 内部的には、参照は Playwright の `aria-ref` により解決されます。

- **ロールスナップショット（`e12` のようなロール参照）**：
  `openclaw browser snapshot --interactive`（または `--compact`、`--depth`、`--selector`、`--frame`）
  - 出力：`[ref=e12]`（および任意の `[nth=1]`）を含むロールベースの一覧／ツリー。
  - アクション：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 内部的には、参照は `getByRole(...)`（重複時は `nth()`）により解決されます。
  - `--labels` を追加すると、参照ラベル `e12` を重ねた
    ビューポートスクリーンショットを含めます。

参照の挙動：

- 参照は **ナビゲーション間で安定しません**。失敗した場合は、`snapshot` を再実行し、
  新しい参照を使用してください。
- ロールスナップショットが `--frame` 付きで取得された場合、
  次のロールスナップショットまでロール参照はその iframe にスコープされます。

## 待機のパワーアップ

時間やテキスト以外にも待機できます：

- URL を待機（Playwright のグロブをサポート）：
  - `openclaw browser wait --url "**/dash"`
- ロード状態を待機：
  - `openclaw browser wait --load networkidle`
- JS の述語を待機：
  - `openclaw browser wait --fn "window.ready===true"`
- セレクターが可視になるのを待機：
  - `openclaw browser wait "#main"`

これらは組み合わせ可能です：

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## デバッグワークフロー

アクションが失敗した場合（例：「not visible」「strict mode violation」「covered」）：

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` を使用（インタラクティブモードではロール参照を優先）
3. それでも失敗する場合：`openclaw browser highlight <ref>` で Playwright のターゲットを確認
4. ページの挙動がおかしい場合：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 深いデバッグにはトレースを記録：
   - `openclaw browser trace start`
   - 問題を再現
   - `openclaw browser trace stop`（`TRACE:<path>` を出力）

## JSON 出力

`--json` はスクリプトや構造化ツール向けです。

例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON のロールスナップショットには `refs` に加え、
ペイロードのサイズや密度を推論できる小さな `stats`
ブロック（lines/chars/refs/interactive）が含まれます。

## 状態および環境ノブ

「サイトを X のように振る舞わせる」ワークフローに有用です：

- Cookie：`cookies`、`cookies set`、`cookies clear`
- ストレージ：`storage local|session get|set|clear`
- オフライン：`set offline on|off`
- ヘッダー：`set headers --json '{"X-Debug":"1"}'`（または `--clear`）
- HTTP Basic 認証：`set credentials user pass`（または `--clear`）
- 位置情報：`set geo <lat> <lon> --origin "https://example.com"`（または `--clear`）
- メディア：`set media dark|light|no-preference|none`
- タイムゾーン／ロケール：`set timezone ...`、`set locale ...`
- デバイス／ビューポート：
  - `set device "iPhone 14"`（Playwright デバイスプリセット）
  - `set viewport 1280 720`

## セキュリティとプライバシー

- openclaw ブラウザープロファイルにはログイン済みセッションが含まれる可能性があります。機密として扱ってください。
- `browser act kind=evaluate` / `openclaw browser evaluate` および `wait --fn` は、
  ページコンテキストで任意の JavaScript を実行します。
  プロンプトインジェクションにより誘導される可能性があります。
  不要な場合は `browser.evaluateEnabled=false` で無効化してください。 17. プロンプトインジェクションによって、
  これが誘導される可能性があります。 `browser.evaluateEnabled=false` で無効にします。
- ログインやアンチボットの注意点（X/Twitter など）については、
  [Browser login + X/Twitter posting](/tools/browser-login) を参照してください。
- Gateway／node host はプライベート（loopback または tailnet のみ）に保ってください。
- リモート CDP エンドポイントは強力です。トンネル化し、保護してください。

## トラブルシューティング

Linux 固有の問題（特に snap の Chromium）については、
[Browser troubleshooting](/tools/browser-linux-troubleshooting) を参照してください。

## エージェントツールと制御の仕組み

エージェントは、ブラウザー自動化のために **1 つのツール** を使用します：

- `browser` — ステータス／開始／停止／タブ／オープン／フォーカス／クローズ／
  スナップショット／スクリーンショット／ナビゲーション／アクション

マップの仕方:

- `browser snapshot` は安定した UI ツリー（AI または ARIA）を返します。
- `browser act` は、スナップショットの `ref` ID を使用して
  クリック／入力／ドラッグ／選択を行います。
- `browser screenshot` はピクセルをキャプチャします（全ページまたは要素）。
- `browser` は次を受け付けます：
  - `profile`：名前付きブラウザープロファイル（openclaw、chrome、または remote CDP）を選択。
  - `target`（`sandbox` | `host` | `node`）：
    ブラウザーの配置場所を選択。
  - サンドボックス化されたセッションでは、`target: "host"` に `agents.defaults.sandbox.browser.allowHostControl=true` が必要です。
  - `target` を省略した場合：
    サンドボックス化セッションは既定で `sandbox`、
    非サンドボックスセッションは既定で `host` になります。
  - ブラウザー対応の node が接続されている場合、
    `target="host"` または `target="node"` で固定しない限り、
    ツールは自動的にそこへルーティングされることがあります。

これにより、エージェントは決定論的になり、脆弱なセレクターを回避できます。
