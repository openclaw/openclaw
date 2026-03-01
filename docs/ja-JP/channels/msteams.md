---
summary: "Microsoft Teamsボットのサポートステータス、機能、および設定"
read_when:
  - MS Teamsチャンネル機能を作業するとき
title: "Microsoft Teams"
---

# Microsoft Teams（プラグイン）

> 「この門をくぐる者、一切の望みを棄てよ。」

更新日: 2026-01-21

ステータス: テキスト + DM添付ファイルに対応しています。チャンネル/グループのファイル送信には`sharePointSiteId` + Graph権限が必要です（[グループチャットでのファイル送信](#グループチャットでのファイル送信)を参照）。投票はAdaptive Cardsで送信されます。

## プラグインが必要

Microsoft Teamsはプラグインとして提供されており、コアインストールにはバンドルされていません。

**破壊的変更（2026.1.15）:** MS Teamsがコアから移動しました。使用する場合はプラグインをインストールする必要があります。

理由: コアインストールを軽量に保ち、MS Teamsの依存関係を独立して更新できるようにします。

CLI経由でインストール（npmレジストリ）:

```bash
openclaw plugins install @openclaw/msteams
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/msteams
```

configure/onboarding中にTeamsを選択し、gitチェックアウトが検出された場合、OpenClawはローカルインストールパスを自動的に提案します。

詳細: [プラグイン](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Microsoft Teamsプラグインをインストールします。
2. **Azure Bot**を作成します（App ID + クライアントシークレット + テナントID）。
3. それらの認証情報でOpenClawを設定します。
4. `/api/messages`（デフォルトポート3978）をパブリックURLまたはトンネル経由で公開します。
5. Teamsアプリパッケージをインストールし、ゲートウェイを起動します。

最小設定:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

注意: グループチャットはデフォルトでブロックされます（`channels.msteams.groupPolicy: "allowlist"`）。グループ返信を許可するには、`channels.msteams.groupAllowFrom`を設定するか（または`groupPolicy: "open"`を使用して任意のメンバーを許可、メンションゲーティング）。

## 目標

- Teams DM、グループチャット、またはチャンネル経由でOpenClawと会話します。
- ルーティングを決定論的に保ちます: 返信は常に到着したチャンネルに戻ります。
- 安全なチャンネル動作をデフォルトとします（設定されない限りメンションが必要）。

## 設定の書き込み

デフォルトでは、Microsoft Teamsは`/config set|unset`でトリガーされる設定更新の書き込みが許可されています（`commands.config: true`が必要）。

無効化:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## アクセス制御（DM + グループ）

**DMアクセス**

- デフォルト: `channels.msteams.dmPolicy = "pairing"`。不明な送信者は承認されるまで無視されます。
- `channels.msteams.allowFrom`には安定したAADオブジェクトIDを使用する必要があります。
- UPN/表示名は変更可能です。ダイレクトマッチングはデフォルトで無効であり、`channels.msteams.dangerouslyAllowNameMatching: true`でのみ有効になります。
- ウィザードは認証情報が許可する場合、Microsoft Graph経由で名前をIDに解決できます。

**グループアクセス**

- デフォルト: `channels.msteams.groupPolicy = "allowlist"`（`groupAllowFrom`を追加しない限りブロック）。`channels.defaults.groupPolicy`を使用して未設定時のデフォルトをオーバーライドできます。
- `channels.msteams.groupAllowFrom`はグループチャット/チャンネルでトリガーできる送信者を制御します（`channels.msteams.allowFrom`にフォールバック）。
- `groupPolicy: "open"`を設定して任意のメンバーを許可します（デフォルトでメンションゲーティング）。
- チャンネルを**一切許可しない**場合は、`channels.msteams.groupPolicy: "disabled"`を設定します。

例:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + チャンネル許可リスト**

- `channels.msteams.teams`にチームとチャンネルをリストしてグループ/チャンネル返信をスコープします。
- キーにはチームIDまたは名前を使用できます。チャンネルキーには会話IDまたは名前を使用できます。
- `groupPolicy="allowlist"`でチーム許可リストが存在する場合、リストされたチーム/チャンネルのみが受け入れられます（メンションゲーティング）。
- configureウィザードは`Team/Channel`エントリを受け付けて保存します。
- 起動時に、OpenClawはチーム/チャンネルとユーザー許可リストの名前をIDに解決し（Graph権限が許可する場合）、マッピングをログに記録します。未解決のエントリは入力されたまま保持されます。

例:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## 仕組み

1. Microsoft Teamsプラグインをインストールします。
2. **Azure Bot**を作成します（App ID + シークレット + テナントID）。
3. ボットを参照し、以下のRSC権限を含む**Teamsアプリパッケージ**を作成します。
4. Teamsアプリをチームにアップロード/インストールします（またはDM用のパーソナルスコープ）。
5. `~/.openclaw/openclaw.json`（または環境変数）で`msteams`を設定し、ゲートウェイを起動します。
6. ゲートウェイはデフォルトで`/api/messages`でBot Frameworkのwebhookトラフィックをリッスンします。

## Azure Botセットアップ（前提条件）

OpenClawを設定する前に、Azure Botリソースを作成する必要があります。

### ステップ1: Azure Botの作成

1. [Azure Botの作成](https://portal.azure.com/#create/Microsoft.AzureBot)にアクセスします
2. **Basics**タブを入力します:

   | フィールド | 値 |
   | ------------------ | -------------------------------------------------------- |
   | **Bot handle** | ボット名（例: `openclaw-msteams`、一意である必要あり） |
   | **Subscription** | Azureサブスクリプションを選択 |
   | **Resource group** | 新規作成または既存を使用 |
   | **Pricing tier** | 開発/テスト用は**Free** |
   | **Type of App** | **Single Tenant**（推奨 - 以下の注意を参照） |
   | **Creation type** | **Create new Microsoft App ID** |

> **非推奨のお知らせ:** 新しいマルチテナントボットの作成は2025-07-31以降非推奨です。新しいボットには**Single Tenant**を使用してください。

3. **Review + create** → **Create**をクリックします（約1-2分待ちます）

### ステップ2: 認証情報の取得

1. Azure Botリソース → **Configuration**に移動します
2. **Microsoft App ID**をコピー → これが`appId`です
3. **Manage Password**をクリック → App Registrationに移動します
4. **Certificates & secrets** → **New client secret** → **Value**をコピー → これが`appPassword`です
5. **Overview** → **Directory (tenant) ID**をコピー → これが`tenantId`です

### ステップ3: メッセージングエンドポイントの設定

1. Azure Bot → **Configuration**で
2. **Messaging endpoint**をwebhook URLに設定します:
   - 本番: `https://your-domain.com/api/messages`
   - ローカル開発: トンネルを使用します（以下の[ローカル開発](#ローカル開発トンネリング)を参照）

### ステップ4: Teamsチャンネルの有効化

1. Azure Bot → **Channels**で
2. **Microsoft Teams** → Configure → Saveをクリックします
3. 利用規約に同意します

## ローカル開発（トンネリング）

Teamsは`localhost`に到達できません。ローカル開発にはトンネルを使用してください:

**オプションA: ngrok**

```bash
ngrok http 3978
# httpsのURLをコピーします（例: https://abc123.ngrok.io）
# メッセージングエンドポイントを設定: https://abc123.ngrok.io/api/messages
```

**オプションB: Tailscale Funnel**

```bash
tailscale funnel 3978
# Tailscale FunnelのURLをメッセージングエンドポイントとして使用します
```

## Teams Developer Portal（代替方法）

マニフェストZIPを手動で作成する代わりに、[Teams Developer Portal](https://dev.teams.microsoft.com/apps)を使用できます:

1. **+ New app**をクリック
2. 基本情報を入力（名前、説明、開発者情報）
3. **App features** → **Bot**に移動
4. **Enter a bot ID manually**を選択し、Azure BotのApp IDを貼り付けます
5. スコープにチェック: **Personal**、**Team**、**Group Chat**
6. **Distribute** → **Download app package**をクリック
7. Teamsで: **Apps** → **Manage your apps** → **Upload a custom app** → ZIPを選択

これはJSONマニフェストを手動で編集するよりも簡単なことが多いです。

## ボットのテスト

**オプションA: Azure Web Chat（まずwebhookを確認）**

1. Azure Portal → Azure Botリソース → **Test in Web Chat**
2. メッセージを送信 - レスポンスが表示されるはずです
3. これによりTeamsセットアップ前にwebhookエンドポイントが機能していることを確認できます

**オプションB: Teams（アプリインストール後）**

1. Teamsアプリをインストール（サイドロードまたは組織カタログ）
2. Teamsでボットを見つけてDMを送信
3. ゲートウェイログで着信アクティビティを確認

## セットアップ（最小テキストのみ）

1. **Microsoft Teamsプラグインのインストール**
   - npmから: `openclaw plugins install @openclaw/msteams`
   - ローカルチェックアウトから: `openclaw plugins install ./extensions/msteams`

2. **ボット登録**
   - Azure Botを作成し（上記参照）、以下をメモします:
     - App ID
     - クライアントシークレット（Appパスワード）
     - テナントID（シングルテナント）

3. **Teamsアプリマニフェスト**
   - `botId = <App ID>`の`bot`エントリを含めます。
   - スコープ: `personal`、`team`、`groupChat`。
   - `supportsFiles: true`（パーソナルスコープのファイル処理に必要）。
   - RSC権限を追加します（以下）。
   - アイコンを作成: `outline.png`（32x32）と`color.png`（192x192）。
   - 3つのファイルをまとめてZip: `manifest.json`、`outline.png`、`color.png`。

4. **OpenClawの設定**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   設定キーの代わりに環境変数も使用できます:
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **ボットエンドポイント**
   - Azure Botのメッセージングエンドポイントを以下に設定:
     - `https://<host>:3978/api/messages`（または選択したパス/ポート）。

6. **ゲートウェイの実行**
   - Teamsチャンネルはプラグインがインストールされ、認証情報付きの`msteams`設定が存在する場合に自動的に起動します。

## 履歴コンテキスト

- `channels.msteams.historyLimit`はプロンプトにラップされる最近のチャンネル/グループメッセージ数を制御します。
- `messages.groupChat.historyLimit`にフォールバックします。無効にするには`0`を設定します（デフォルト50）。
- DM履歴は`channels.msteams.dmHistoryLimit`（ユーザーターン）で制限できます。ユーザーごとのオーバーライド: `channels.msteams.dms["<user_id>"].historyLimit`。

## 現在のTeams RSC権限（マニフェスト）

これらはTeamsアプリマニフェストの**既存のresourceSpecific権限**です。アプリがインストールされているチーム/チャット内でのみ適用されます。

**チャンネル用（チームスコープ）:**

- `ChannelMessage.Read.Group`（Application）- @メンションなしですべてのチャンネルメッセージを受信
- `ChannelMessage.Send.Group`（Application）
- `Member.Read.Group`（Application）
- `Owner.Read.Group`（Application）
- `ChannelSettings.Read.Group`（Application）
- `TeamMember.Read.Group`（Application）
- `TeamSettings.Read.Group`（Application）

**グループチャット用:**

- `ChatMessage.Read.Chat`（Application）- @メンションなしですべてのグループチャットメッセージを受信

## Teamsマニフェストの例（編集済み）

必要なフィールドを含む最小限の有効な例です。IDとURLを置き換えてください。

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### マニフェストの注意事項（必須フィールド）

- `bots[].botId`はAzure BotのApp IDと**一致する必要があります**。
- `webApplicationInfo.id`はAzure BotのApp IDと**一致する必要があります**。
- `bots[].scopes`には使用する予定のサーフェスを含める必要があります（`personal`、`team`、`groupChat`）。
- `bots[].supportsFiles: true`はパーソナルスコープのファイル処理に必要です。
- `authorization.permissions.resourceSpecific`にはチャンネルトラフィックが必要な場合、チャンネルの読み取り/送信を含める必要があります。

### 既存アプリの更新

既にインストールされているTeamsアプリを更新する場合（例: RSC権限の追加）:

1. `manifest.json`を新しい設定で更新
2. **`version`フィールドをインクリメント**（例: `1.0.0` → `1.1.0`）
3. マニフェストとアイコンを**再ZIP**（`manifest.json`、`outline.png`、`color.png`）
4. 新しいZIPをアップロード:
   - **オプションA（Teams Admin Center）:** Teams Admin Center → Teams apps → Manage apps → アプリを検索 → Upload new version
   - **オプションB（サイドロード）:** Teamsで → Apps → Manage your apps → Upload a custom app
5. **チームチャンネルの場合:** 新しい権限を有効にするために各チームでアプリを再インストール
6. **Teamsを完全に終了して再起動**（ウィンドウを閉じるだけでなく）してキャッシュされたアプリメタデータをクリア

## 機能: RSCのみ vs Graph

### **Teams RSCのみ**（アプリインストール済み、Graph API権限なし）

動作するもの:

- チャンネルメッセージの**テキスト**コンテンツの読み取り。
- チャンネルメッセージの**テキスト**コンテンツの送信。
- **パーソナル（DM）**ファイル添付ファイルの受信。

動作しないもの:

- チャンネル/グループの**画像またはファイルコンテンツ**（ペイロードにはHTMLスタブのみ含まれる）。
- SharePoint/OneDriveに保存された添付ファイルのダウンロード。
- メッセージ履歴の読み取り（ライブwebhookイベントを超えて）。

### **Teams RSC + Microsoft Graphアプリケーション権限**

追加されるもの:

- ホストされたコンテンツ（メッセージに貼り付けられた画像）のダウンロード。
- SharePoint/OneDriveに保存されたファイル添付ファイルのダウンロード。
- Graph経由でのチャンネル/チャットメッセージ履歴の読み取り。

### RSC vs Graph API

| 機能 | RSC権限 | Graph API |
| ----------------------- | -------------------- | ----------------------------------- |
| **リアルタイムメッセージ** | はい（webhook経由） | いいえ（ポーリングのみ） |
| **過去のメッセージ** | いいえ | はい（履歴をクエリ可能） |
| **セットアップの複雑さ** | アプリマニフェストのみ | 管理者の同意 + トークンフローが必要 |
| **オフライン動作** | いいえ（実行中である必要あり） | はい（いつでもクエリ可能） |

**結論:** RSCはリアルタイムリスニング用、Graph APIは過去のアクセス用です。オフライン中に見逃したメッセージをキャッチアップするには、`ChannelMessage.Read.All`を持つGraph API（管理者の同意が必要）が必要です。

## Graph対応メディア + 履歴（チャンネルに必要）

チャンネルでの画像/ファイルや**メッセージ履歴**の取得が必要な場合は、Microsoft Graph権限を有効にし、管理者の同意を付与する必要があります。

1. Entra ID（Azure AD）の**App Registration**で、Microsoft Graphの**アプリケーション権限**を追加:
   - `ChannelMessage.Read.All`（チャンネル添付ファイル + 履歴）
   - `Chat.Read.All`または`ChatMessage.Read.All`（グループチャット）
2. テナントの**管理者の同意を付与**します。
3. Teamsアプリの**マニフェストバージョンをバンプ**し、再アップロードして、**Teamsでアプリを再インストール**します。
4. **Teamsを完全に終了して再起動**してキャッシュされたアプリメタデータをクリアします。

**ユーザーメンション用の追加権限:** ユーザー@メンションは会話内のユーザーに対してはそのまま動作します。ただし、**現在の会話にいないユーザー**を動的に検索してメンションする場合は、`User.Read.All`（Application）権限を追加し、管理者の同意を付与してください。

## 既知の制限事項

### Webhookタイムアウト

TeamsはHTTP webhook経由でメッセージを配信します。処理に時間がかかりすぎる場合（例: 遅いLLMレスポンス）、以下が発生する可能性があります:

- ゲートウェイタイムアウト
- Teamsがメッセージをリトライ（重複の原因）
- 返信のドロップ

OpenClawは素早く返信し、プロアクティブに応答を送信することでこれに対処しますが、非常に遅い応答では問題が発生する可能性があります。

### フォーマット

TeamsのMarkdownはSlackやDiscordより制限されています:

- 基本的なフォーマットは動作します: **太字**、_イタリック_、`コード`、リンク
- 複雑なMarkdown（テーブル、ネストされたリスト）は正しくレンダリングされない場合があります
- Adaptive Cardsは投票や任意のカード送信に対応しています（以下参照）

## 設定

主な設定（共有チャンネルパターンについては`/gateway/configuration`を参照）:

- `channels.msteams.enabled`: チャンネルの有効化/無効化。
- `channels.msteams.appId`、`channels.msteams.appPassword`、`channels.msteams.tenantId`: ボット認証情報。
- `channels.msteams.webhook.port`（デフォルト`3978`）
- `channels.msteams.webhook.path`（デフォルト`/api/messages`）
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）
- `channels.msteams.allowFrom`: DM許可リスト（AADオブジェクトIDを推奨）。ウィザードはGraph アクセスが利用可能な場合、セットアップ中に名前をIDに解決します。
- `channels.msteams.dangerouslyAllowNameMatching`: 変更可能なUPN/表示名マッチングを再有効化するブレークグラストグル。
- `channels.msteams.textChunkLimit`: 送信テキストチャンクサイズ。
- `channels.msteams.chunkMode`: `length`（デフォルト）または`newline`で長さチャンキングの前に空行（段落境界）で分割。
- `channels.msteams.mediaAllowHosts`: 受信添付ファイルホストの許可リスト（デフォルトはMicrosoft/Teamsドメイン）。
- `channels.msteams.mediaAuthAllowHosts`: メディアリトライ時にAuthorizationヘッダーを添付するホストの許可リスト（デフォルトはGraph + Bot Frameworkホスト）。
- `channels.msteams.requireMention`: チャンネル/グループで@メンションを要求（デフォルトtrue）。
- `channels.msteams.replyStyle`: `thread | top-level`（[返信スタイル](#返信スタイルスレッド-vs-投稿)を参照）。
- `channels.msteams.teams.<teamId>.replyStyle`: チームごとのオーバーライド。
- `channels.msteams.teams.<teamId>.requireMention`: チームごとのオーバーライド。
- `channels.msteams.teams.<teamId>.tools`: チャンネルオーバーライドがない場合に使用されるデフォルトのチームごとのツールポリシーオーバーライド（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.teams.<teamId>.toolsBySender`: デフォルトのチームごとの送信者別ツールポリシーオーバーライド（`"*"`ワイルドカード対応）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: チャンネルごとのオーバーライド。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: チャンネルごとのオーバーライド。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: チャンネルごとのツールポリシーオーバーライド（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: チャンネルごとの送信者別ツールポリシーオーバーライド（`"*"`ワイルドカード対応）。
- `toolsBySender`キーには明示的なプレフィックスを使用する必要があります:
  `id:`、`e164:`、`username:`、`name:`（レガシーのプレフィックスなしキーは`id:`のみにマッピングされます）。
- `channels.msteams.sharePointSiteId`: グループチャット/チャンネルでのファイルアップロード用SharePointサイトID（[グループチャットでのファイル送信](#グループチャットでのファイル送信)を参照）。

## ルーティングとセッション

- セッションキーは標準的なエージェント形式に従います（[/concepts/session](/concepts/session)を参照）:
  - ダイレクトメッセージはメインセッションを共有します（`agent:<agentId>:<mainKey>`）。
  - チャンネル/グループメッセージは会話IDを使用します:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 返信スタイル: スレッド vs 投稿

Teamsは最近、同じ基盤データモデル上に2つのチャンネルUIスタイルを導入しました:

| スタイル | 説明 | 推奨`replyStyle` |
| ------------------------ | --------------------------------------------------------- | ------------------------ |
| **Posts**（クラシック） | メッセージがカードとして表示され、その下にスレッド返信がつく | `thread`（デフォルト） |
| **Threads**（Slackライク） | メッセージがSlackのように線形に流れる | `top-level` |

**問題:** Teams APIはチャンネルがどのUIスタイルを使用しているか公開しません。間違った`replyStyle`を使用すると:

- Threadsスタイルのチャンネルで`thread` → 返信が不自然にネストされる
- Postsスタイルのチャンネルで`top-level` → 返信がスレッド内ではなく別のトップレベル投稿として表示される

**解決策:** チャンネルの設定方法に基づいてチャンネルごとに`replyStyle`を設定します:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## 添付ファイルと画像

**現在の制限事項:**

- **DM:** 画像とファイル添付ファイルはTeamsボットファイルAPI経由で動作します。
- **チャンネル/グループ:** 添付ファイルはM365ストレージ（SharePoint/OneDrive）に存在します。webhookペイロードにはHTMLスタブのみが含まれ、実際のファイルバイトは含まれません。チャンネル添付ファイルのダウンロードには**Graph API権限が必要**です。

Graph権限がない場合、画像を含むチャンネルメッセージはテキストのみとして受信されます（画像コンテンツにボットはアクセスできません）。
デフォルトでは、OpenClawはMicrosoft/Teamsホスト名からのみメディアをダウンロードします。`channels.msteams.mediaAllowHosts`でオーバーライドします（任意のホストを許可するには`["*"]`を使用）。
Authorizationヘッダーは`channels.msteams.mediaAuthAllowHosts`のホストにのみ添付されます（デフォルトはGraph + Bot Frameworkホスト）。このリストは厳密に保ってください（マルチテナントサフィックスを避けてください）。

## グループチャットでのファイル送信

ボットはFileConsentCardフロー（組み込み）を使用してDMでファイルを送信できます。ただし、**グループチャット/チャンネルでのファイル送信**には追加のセットアップが必要です:

| コンテキスト | ファイルの送信方法 | 必要なセットアップ |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| **DM** | FileConsentCard → ユーザーが承認 → ボットがアップロード | そのまま動作 |
| **グループチャット/チャンネル** | SharePointにアップロード → 共有リンク | `sharePointSiteId` + Graph権限が必要 |
| **画像（任意のコンテキスト）** | Base64エンコードインライン | そのまま動作 |

### グループチャットにSharePointが必要な理由

ボットは個人用OneDriveドライブを持ちません（`/me/drive` Graph APIエンドポイントはアプリケーションIDでは動作しません）。グループチャット/チャンネルでファイルを送信するために、ボットは**SharePointサイト**にアップロードして共有リンクを作成します。

### セットアップ

1. Entra ID（Azure AD）→ App Registrationで**Graph API権限**を追加:
   - `Sites.ReadWrite.All`（Application）- SharePointへのファイルアップロード
   - `Chat.Read.All`（Application）- オプション、ユーザーごとの共有リンクを有効化

2. テナントの**管理者の同意を付与**します。

3. **SharePointサイトIDの取得:**

   ```bash
   # Graph Explorerまたは有効なトークンを使用したcurl経由:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # 例: "contoso.sharepoint.com/sites/BotFiles"のサイトの場合
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # レスポンスに含まれる: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClawの設定:**

   ```json5
   {
     channels: {
       msteams: {
         // ... その他の設定 ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### 共有動作

| 権限 | 共有動作 |
| --------------------------------------- | --------------------------------------------------------- |
| `Sites.ReadWrite.All`のみ | 組織全体の共有リンク（組織内の誰でもアクセス可能） |
| `Sites.ReadWrite.All` + `Chat.Read.All` | ユーザーごとの共有リンク（チャットメンバーのみアクセス可能） |

ユーザーごとの共有はチャット参加者のみがファイルにアクセスできるため、より安全です。`Chat.Read.All`権限がない場合、ボットは組織全体の共有にフォールバックします。

### フォールバック動作

| シナリオ | 結果 |
| ------------------------------------------------- | -------------------------------------------------- |
| グループチャット + ファイル + `sharePointSiteId`設定済み | SharePointにアップロード、共有リンクを送信 |
| グループチャット + ファイル + `sharePointSiteId`なし | OneDriveアップロードを試行（失敗する可能性あり）、テキストのみ送信 |
| パーソナルチャット + ファイル | FileConsentCardフロー（SharePointなしで動作） |
| 任意のコンテキスト + 画像 | Base64エンコードインライン（SharePointなしで動作） |

### ファイルの保存場所

アップロードされたファイルは、設定されたSharePointサイトのデフォルトドキュメントライブラリ内の`/OpenClawShared/`フォルダに保存されます。

## 投票（Adaptive Cards）

OpenClawはTeamsの投票をAdaptive Cardsとして送信します（ネイティブのTeams投票APIはありません）。

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票は`~/.openclaw/msteams-polls.json`にゲートウェイが記録します。
- 投票を記録するにはゲートウェイがオンラインである必要があります。
- 投票はまだ結果サマリーを自動投稿しません（必要な場合はストアファイルを検査してください）。

## Adaptive Cards（任意）

メッセージツールまたはCLIを使用して、任意のAdaptive Card JSONをTeamsユーザーまたは会話に送信します。

`card`パラメータはAdaptive Card JSONオブジェクトを受け付けます。`card`が提供される場合、メッセージテキストはオプションです。

**エージェントツール:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Adaptive Cardsのスキーマと例については[Adaptive Cardsドキュメント](https://adaptivecards.io/)を参照してください。ターゲット形式の詳細については、以下の[ターゲット形式](#ターゲット形式)を参照してください。

## ターゲット形式

MSTeamsのターゲットはユーザーと会話を区別するためにプレフィックスを使用します:

| ターゲットタイプ | 形式 | 例 |
| ------------------- | -------------------------------- | --------------------------------------------------- |
| ユーザー（IDで） | `user:<aad-object-id>` | `user:40a1a0ed-4ff2-4164-a219-55518990c197` |
| ユーザー（名前で） | `user:<display-name>` | `user:John Smith`（Graph APIが必要） |
| グループ/チャンネル | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2` |
| グループ/チャンネル（生） | `<conversation-id>` | `19:abc123...@thread.tacv2`（`@thread`を含む場合） |

**CLIの例:**

```bash
# IDでユーザーに送信
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 表示名でユーザーに送信（Graph API検索をトリガー）
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# グループチャットまたはチャンネルに送信
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# 会話にAdaptive Cardを送信
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**エージェントツールの例:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

注意: `user:`プレフィックスがない場合、名前はグループ/チーム解決にデフォルトされます。表示名でユーザーをターゲットにする場合は常に`user:`を使用してください。

## プロアクティブメッセージング

- プロアクティブメッセージは、ユーザーがインタラクションした**後**にのみ可能です。その時点で会話リファレンスを保存するためです。
- `dmPolicy`と許可リストゲーティングについては`/gateway/configuration`を参照してください。

## チームとチャンネルID（よくある落とし穴）

TeamsのURLの`groupId`クエリパラメータはconfiguration用のチームIDでは**ありません**。代わりにURLパスからIDを抽出してください:

**チームURL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    チームID（これをURLデコード）
```

**チャンネルURL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      チャンネルID（これをURLデコード）
```

**設定用:**

- チームID = `/team/`後のパスセグメント（URLデコード済み、例: `19:Bk4j...@thread.tacv2`）
- チャンネルID = `/channel/`後のパスセグメント（URLデコード済み）
- `groupId`クエリパラメータは**無視**してください

## プライベートチャンネル

ボットはプライベートチャンネルで限定的なサポートがあります:

| 機能 | 標準チャンネル | プライベートチャンネル |
| ---------------------------- | ----------------- | ---------------------- |
| ボットのインストール | はい | 制限あり |
| リアルタイムメッセージ（webhook） | はい | 動作しない場合あり |
| RSC権限 | はい | 動作が異なる場合あり |
| @メンション | はい | ボットがアクセス可能な場合 |
| Graph API履歴 | はい | はい（権限があれば） |

**プライベートチャンネルが動作しない場合の回避策:**

1. ボットのインタラクションには標準チャンネルを使用
2. DMを使用 - ユーザーはいつでもボットに直接メッセージを送信できます
3. 過去のアクセスにはGraph APIを使用（`ChannelMessage.Read.All`が必要）

## トラブルシューティング

### 一般的な問題

- **チャンネルで画像が表示されない:** Graph権限または管理者の同意が不足しています。Teamsアプリを再インストールし、Teamsを完全に終了/再開してください。
- **チャンネルで応答がない:** デフォルトではメンションが必要です。`channels.msteams.requireMention=false`を設定するか、チーム/チャンネルごとに設定してください。
- **バージョン不一致（Teamsがまだ古いマニフェストを表示）:** アプリを削除 + 再追加し、Teamsを完全に終了してリフレッシュしてください。
- **webhookからの401 Unauthorized:** Azure JWTなしで手動テストする場合に予想されます。エンドポイントに到達可能だが認証に失敗したことを意味します。適切なテストにはAzure Web Chatを使用してください。

### マニフェストアップロードエラー

- **「Icon file cannot be empty」:** マニフェストが参照するアイコンファイルが0バイトです。有効なPNGアイコンを作成してください（`outline.png`は32x32、`color.png`は192x192）。
- **「webApplicationInfo.Id already in use」:** アプリが別のチーム/チャットにまだインストールされています。まずそれを見つけてアンインストールするか、5-10分の伝播を待ってください。
- **アップロード時に「Something went wrong」:** 代わりに[https://admin.teams.microsoft.com](https://admin.teams.microsoft.com)経由でアップロードし、ブラウザDevTools（F12）→ Networkタブを開いて、レスポンスボディで実際のエラーを確認してください。
- **サイドロードが失敗:** 「Upload a custom app」の代わりに「Upload an app to your org's app catalog」を試してください。これによりサイドロード制限を回避できることが多いです。

### RSC権限が動作しない

1. `webApplicationInfo.id`がボットのApp IDと正確に一致していることを確認
2. アプリを再アップロードし、チーム/チャットに再インストール
3. 組織の管理者がRSC権限をブロックしていないか確認
4. 正しいスコープを使用していることを確認: チーム用は`ChannelMessage.Read.Group`、グループチャット用は`ChatMessage.Read.Chat`

## リファレンス

- [Azure Botの作成](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Botセットアップガイド
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - Teamsアプリの作成/管理
- [Teamsアプリマニフェストスキーマ](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [RSCでチャンネルメッセージを受信](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC権限リファレンス](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teamsボットのファイル処理](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)（チャンネル/グループにはGraphが必要）
- [プロアクティブメッセージング](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
