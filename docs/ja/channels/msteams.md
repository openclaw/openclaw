---
summary: "Microsoft Teams ボットのサポート状況、機能、設定"
read_when:
  - MS Teams チャンネル機能に取り組んでいるとき
title: "Microsoft Teams"
---

# Microsoft Teams（プラグイン）

> 「ここに足を踏み入れる者は、すべての希望を捨てよ。」

更新日: 2026-01-21

ステータス: テキスト + DM 添付ファイルはサポートされています。チャンネル／グループでのファイル送信には `sharePointSiteId` + Graph 権限が必要です（[グループチャットでのファイル送信](#sending-files-in-group-chats) を参照）。投票は Adaptive Cards 経由で送信されます。 アンケートはアダプティブカードで送信されます。

## プラグインが必要

Microsoft Teams はプラグインとして提供され、コアインストールには含まれません。

**破壊的変更（2026.1.15）:** MS Teams はコアから分離されました。使用する場合は、プラグインをインストールする必要があります。 それを使用する場合は、プラグインをインストールする必要があります。

理由: コアインストールを軽量に保ち、MS Teams 依存関係を独立して更新できるようにするためです。

CLI でインストール（npm レジストリ）:

```bash
openclaw plugins install @openclaw/msteams
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/msteams
```

設定／オンボーディング時に Teams を選択し、git チェックアウトが検出された場合、OpenClaw はローカルインストールパスを自動的に提案します。

詳細: [Plugins](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Microsoft Teams プラグインをインストールします。
2. **Azure Bot**（App ID + クライアントシークレット + テナント ID）を作成します。
3. それらの資格情報で OpenClaw を設定します。
4. `/api/messages`（デフォルトはポート 3978）を公開 URL またはトンネル経由で公開します。
5. Teams アプリパッケージをインストールし、ゲートウェイを起動します。

最小構成:

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

注記: グループチャットはデフォルトでブロックされています（`channels.msteams.groupPolicy: "allowlist"`）。グループ返信を許可するには `channels.msteams.groupAllowFrom` を設定してください（または、メンション必須で任意メンバーを許可する `groupPolicy: "open"` を使用します）。 グループの返信を許可するには、 `channels.msteams.groupAllowFrom` を設定します。（またはメンションされたメンバーを許可するには、 `groupPolicy: "open"` を使用します）

## 目標

- Teams の DM、グループチャット、またはチャンネル経由で OpenClaw と対話する。
- ルーティングを決定的に保つ: 返信は常に受信元のチャンネルに戻る。
- 安全なチャンネル動作をデフォルトにする（設定されていない限りメンション必須）。

## 設定の書き込み

デフォルトでは、Microsoft Teams は `/config set|unset` によってトリガーされる設定更新の書き込みを許可されています（`commands.config: true` が必要）。

無効化するには:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## アクセス制御（DM + グループ）

**DM アクセス**

- デフォルト: `channels.msteams.dmPolicy = "pairing"`。不明な送信者は承認されるまで無視されます。 承認されるまで不明な送信者は無視されます。
- `channels.msteams.allowFrom` は AAD オブジェクト ID、UPN、または表示名を受け付けます。ウィザードは、資格情報が許可する場合に Microsoft Graph を介して名前を ID に解決します。 資格情報が許可されている場合、ウィザードは名前をMicrosoft Graph経由でIDに解決します。

**グループアクセス**

- `channels.msteams.teams.<teamId> .tools`: チャンネル上書きがない場合に使用される、チームごとのデフォルトツールポリシー上書き（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.groupAllowFrom` は、グループチャット／チャンネルでトリガーできる送信者を制御します（`channels.msteams.allowFrom` にフォールバック）。
- 任意メンバーを許可するには `groupPolicy: "open"` を設定します（デフォルトでは引き続きメンション必須）。
- **チャンネルを一切許可しない** 場合は `channels.msteams.groupPolicy: "disabled"` を設定します。

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

- `channels.msteams.teams` の下にチームとチャンネルを列挙して、グループ／チャンネル返信のスコープを制限します。
- キーにはチーム ID または名前を使用できます。チャンネルキーには会話 ID または名前を使用できます。
- `groupPolicy="allowlist"` が有効で、チーム許可リストが存在する場合、列挙されたチーム／チャンネルのみが受け付けられます（メンション必須）。
- 設定ウィザードは `Team/Channel` エントリを受け付け、保存します。
- 起動時、OpenClaw は（Graph 権限が許可されている場合）チーム／チャンネルおよびユーザー許可リストの名前を ID に解決し、マッピングをログに出力します。解決できないエントリは入力どおり保持されます。

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

## How it works

1. Microsoft Teams プラグインをインストールします。
2. **Azure Bot**（App ID + シークレット + テナント ID）を作成します。
3. ボットを参照し、以下の RSC 権限を含む **Teams アプリパッケージ** を作成します。
4. Teams アプリをチームにアップロード／インストールします（DM の場合は個人スコープ）。
5. `msteams` を `~/.openclaw/openclaw.json`（または環境変数）に設定し、ゲートウェイを起動します。
6. ゲートウェイは、デフォルトで `/api/messages` 上の Bot Framework Webhook トラフィックを待ち受けます。

## Azure Bot セットアップ（前提条件）

OpenClaw を設定する前に、Azure Bot リソースを作成する必要があります。

### ステップ 1: Azure Bot を作成

1. [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot) にアクセスします。
2. **Basics** タブを入力します。

   | フィールド              | 値                                                     |
   | ------------------ | ----------------------------------------------------- |
   | **Bot handle**     | ボット名（例: `openclaw-msteams`、一意である必要あり） |
   | **Subscription**   | Azure サブスクリプションを選択                                    |
   | **Resource group** | 新規作成または既存を使用                                          |
   | **Pricing tier**   | 開発／テスト用に **Free**                                     |
   | **Type of App**    | **Single Tenant**（推奨、下記注記参照）                          |
   | **Creation type**  | **Create new Microsoft App ID**                       |

> **廃止通知:** マルチテナントボットの作成は2025-07-31以降推奨されませんでした。 **非推奨のお知らせ:** 新規のマルチテナントボットの作成は 2025-07-31 以降非推奨です。新規ボットには **Single Tenant** を使用してください。

3. **Review + create** → **Create** をクリックします（約 1～2 分待機）。

### ステップ 2: 資格情報を取得

1. Azure Bot リソース → **Configuration** に移動します。
2. **Microsoft App ID** をコピーします。これが `appId` です。
3. **Manage Password** をクリックし、App Registration に移動します。
4. **Certificates & secrets** → **New client secret** → **Value** をコピーします。これが `appPassword` です。
5. **Overview** → **Directory (tenant) ID** をコピーします。これが `tenantId` です。

### ステップ 3: メッセージングエンドポイントを設定

1. Azure Bot → **Configuration**
2. **Messaging endpoint** に Webhook URL を設定します。
   - 本番: `https://your-domain.com/api/messages`
   - ローカル開発: トンネルを使用します（下記 [ローカル開発](#local-development-tunneling) を参照）。

### ステップ 4: Teams チャンネルを有効化

1. Azure Bot → **Channels**
2. **Microsoft Teams** → Configure → Save
3. 利用規約に同意する

## ローカル開発（トンネリング）

Teams は `localhost` に到達できません。ローカル開発にはトンネルを使用します。 地域開発のためにトンネルを使用してください:

**オプション A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**オプション B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal（代替手段）

マニフェスト ZIP を手動で作成する代わりに、[Teams Developer Portal](https://dev.teams.microsoft.com/apps) を使用できます。

1. **+ New app** をクリックします。
2. 基本情報（名前、説明、開発者情報）を入力します。
3. **App features** → **Bot** に移動します。
4. **Enter a bot ID manually** を選択し、Azure Bot の App ID を貼り付けます。
5. スコープを選択します: **Personal**, **Team**, **Group Chat**
6. **Distribute** → **Download app package** をクリックします。
7. Teams で **Apps** → **Manage your apps** → **Upload a custom app** → ZIP を選択します。

JSON マニフェストを手編集するより簡単な場合が多いです。

## ボットのテスト

**オプション A: Azure Web Chat（Webhook の事前確認）**

1. Azure Portal → Azure Bot リソース → **Test in Web Chat**
2. メッセージを送信し、応答が返ることを確認します。
3. これにより、Teams 設定前に Webhook エンドポイントが動作していることを確認できます。

**オプション B: Teams（アプリインストール後）**

1. Teams アプリをインストールします（サイドロードまたは組織カタログ）。
2. Teams でボットを見つけ、DM を送信します。
3. ゲートウェイログで受信アクティビティを確認します。

## セットアップ（最小・テキストのみ）

1. **Microsoft Teams プラグインをインストール**
   - npm から: `openclaw plugins install @openclaw/msteams`
   - ローカルチェックアウトから: `openclaw plugins install ./extensions/msteams`

2. **ボット登録**
   - Azure Bot を作成し（上記参照）、以下を控えます。
     - App ID
     - クライアントシークレット（App パスワード）
     - テナント ID（シングルテナント）

3. **Teams アプリマニフェスト**
   - `botId = <App ID>` を含む `bot` エントリを追加します。
   - スコープ: `personal`, `team`, `groupChat`。
   - `supportsFiles: true`（個人スコープのファイル処理に必須）。
   - RSC 権限を追加します（下記）。
   - アイコンを作成します: `outline.png`（32x32）および `color.png`（192x192）。
   - 3 つのファイルを ZIP 化します: `manifest.json`, `outline.png`, `color.png`。

4. **OpenClaw を設定**

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

   設定キーの代わりに環境変数を使用することもできます。

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **ボットエンドポイント**
   - Azure Bot の Messaging Endpoint を以下に設定します。
     - `https://<host>:3978/api/messages`（または任意のパス／ポート）。

6. **ゲートウェイを実行**
   - プラグインがインストールされ、資格情報を含む `msteams` 設定が存在する場合、Teams チャンネルは自動的に起動します。

## 履歴コンテキスト

- `channels.msteams.historyLimit` は、最近のチャンネル／グループメッセージをプロンプトに含める数を制御します。
- `messages.groupChat.historyLimit` にフォールバックします。無効化するには `0` を設定します（デフォルト 50）。 `0`を無効にします（デフォルトは50）。
- DM 履歴は `channels.msteams.dmHistoryLimit`（ユーザーターン）で制限できます。ユーザーごとの上書き: `channels.msteams.dms["<user_id>"].historyLimit`。 `channels.imessage.dmHistoryLimit`: ユーザー ターン数での DM 履歴上限。ユーザーごとの上書き: `channels.msteams.dms["<user_id>"].historyLimit`。

## 現在の Teams RSC 権限（マニフェスト）

これらは Teams アプリマニフェスト内の **既存の resourceSpecific 権限** です。アプリがインストールされているチーム／チャット内でのみ適用されます。 アプリがインストールされているチーム/チャット内でのみ適用されます。

**チャンネル（チームスコープ）:**

- `ChannelMessage.Read.Group`（Application）- @mention なしで全チャンネルメッセージを受信
- `ChannelMessage.Send.Group`（Application）
- `Member.Read.Group`（Application）
- `Owner.Read.Group`（Application）
- `ChannelSettings.Read.Group`（Application）
- `TeamMember.Read.Group`（Application）
- `TeamSettings.Read.Group`（Application）

**グループチャット:**

- `ChatMessage.Read.Chat`（Application）- @mention なしで全グループチャットメッセージを受信

## Teams マニフェスト例（要約）

必須フィールドを含む最小で有効な例です。ID と URL を置き換えてください。 IDとURLを置き換えます。

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

### マニフェストの注意点（必須項目）

- `bots[].botId` は Azure Bot の App ID と **一致する必要があります**。
- `webApplicationInfo.id` は Azure Bot の App ID と **一致する必要があります**。
- `bots[].scopes` には使用予定のサーフェス（`personal`, `team`, `groupChat`）を含める必要があります。
- `bots[].supportsFiles: true` は個人スコープでのファイル処理に必須です。
- チャンネルトラフィックを扱う場合、`authorization.permissions.resourceSpecific` にはチャンネルの read/send を含める必要があります。

### 既存アプリの更新

既にインストールされている Teams アプリを更新する場合（例: RSC 権限の追加）:

1. 新しい設定で `manifest.json` を更新します。
2. **`version` フィールドをインクリメント** します（例: `1.0.0` → `1.1.0`）。
3. アイコンとともに **再 ZIP** します（`manifest.json`, `outline.png`, `color.png`）。
4. 新しい ZIP をアップロードします。
   - **オプション A（Teams Admin Center）:** Teams Admin Center → Teams apps → Manage apps → 対象アプリ → Upload new version
   - **オプション B（サイドロード）:** Teams → Apps → Manage your apps → Upload a custom app
5. **チームチャンネルの場合:** 新しい権限を有効にするため、各チームでアプリを再インストールします。
6. **Teams を完全に終了して再起動** します（ウィンドウを閉じるだけでは不可）。

## 機能: RSC のみ vs Graph

### **Teams RSC のみ**（アプリがインストール済み、Graph API 権限なし）

動作するもの:

- チャンネルメッセージの **テキスト** 読み取り。
- チャンネルメッセージの **テキスト** 送信。
- **個人（DM）** のファイル添付の受信。

動作しないもの:

- チャンネル／グループの **画像やファイル内容**（ペイロードには HTML スタブのみ）。
- SharePoint／OneDrive に保存された添付ファイルのダウンロード。
- メッセージ履歴の読み取り（ライブ Webhook イベント以外）。

### **Teams RSC + Microsoft Graph Application 権限**

追加される機能:

- メッセージに貼り付けられたホスト済みコンテンツ（画像）のダウンロード。
- SharePoint／OneDrive に保存されたファイル添付のダウンロード。
- Graph 経由でのチャンネル／チャットのメッセージ履歴読み取り。

### RSC と Graph API の比較

| Capability      | RSC 権限       | Graph API          |
| --------------- | ------------ | ------------------ |
| **リアルタイムメッセージ** | はい（Webhook）  | いいえ（ポーリングのみ）       |
| **履歴メッセージ**     | いいえ          | はい（履歴をクエリ可能）       |
| **セットアップの複雑さ**  | アプリマニフェストのみ  | 管理者同意 + トークンフローが必要 |
| **オフライン動作**     | いいえ（常時実行が必要） | はい（いつでもクエリ可能）      |

**結論:** RSC はリアルタイムリスニング向け、Graph API は履歴アクセス向けです。オフライン中に取りこぼしたメッセージを補完するには、管理者同意が必要な `ChannelMessage.Read.All` を含む Graph API が必要です。 オフラインで失敗したメッセージに追加するには、Graph APIに`ChannelMessage.Read.All`が必要です(管理者の同意が必要です)。

## Graph 有効のメディア + 履歴（チャンネルに必須）

**チャンネル**で画像／ファイルが必要、または **メッセージ履歴** を取得したい場合は、Microsoft Graph 権限を有効化し、管理者同意を付与する必要があります。

1. Entra ID（Azure AD）の **App Registration** で Microsoft Graph **Application 権限** を追加します。
   - `ChannelMessage.Read.All`（チャンネル添付 + 履歴）
   - `Chat.Read.All` または `ChatMessage.Read.All`（グループチャット）
2. テナントに対して **管理者同意** を付与します。
3. Teams アプリの **マニフェストバージョン** を上げ、再アップロードし、**Teams でアプリを再インストール** します。
4. **Teams を完全に終了して再起動** し、キャッシュされたアプリメタデータをクリアします。

## 既知の制限

### Webhook タイムアウト

Teams は HTTP Webhook 経由でメッセージを配信します。処理に時間がかかりすぎる場合（例: LLM 応答が遅い場合）、以下が発生する可能性があります。 処理に時間がかかりすぎる場合(例:遅いLLM応答)、次のようになります。

- ゲートウェイのタイムアウト
- Teams によるメッセージの再試行（重複の原因）
- 返信の欠落

OpenClaw は迅速に応答を返し、プロアクティブに返信を送信することで対処していますが、極端に遅い応答では問題が発生する場合があります。

### 書式

Teams の Markdown は Slack や Discord より制限があります。

- 基本的な書式は動作します: **太字**, _斜体_, `code`, リンク
- 複雑な Markdown（表、ネストされたリスト）は正しく表示されない場合があります。
- 投票や任意のカード送信には Adaptive Cards がサポートされています（下記参照）。

## 設定

主要設定（共有チャンネルパターンは `/gateway/configuration` を参照）:

- `channels.msteams.enabled`: チャンネルの有効／無効。
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: ボット資格情報。
- `channels.msteams.webhook.port`（デフォルト `3978`）
- `channels.msteams.webhook.path`（デフォルト `/api/messages`）
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）
- `channels.msteams.allowFrom`: allowlist for DM (AAD object ID, UPN, or display names). グラフへのアクセスが可能な場合、セットアップ時に名前をIDに変更します。
- `channels.msteams.textChunkLimit`: 送信テキストのチャンクサイズ。
- `channels.msteams.chunkMode`: `length`（デフォルト）または `newline` を使用して、長さ分割前に空行（段落境界）で分割します。
- `channels.msteams.mediaAllowHosts`: 受信添付のホスト許可リスト（デフォルトは Microsoft／Teams ドメイン）。
- `channels.msteams.mediaAuthAllowHosts`: メディア再試行時に Authorization ヘッダーを付与するホストの許可リスト（デフォルトは Graph + Bot Framework ホスト）。
- `channels.msteams.requireMention`: チャンネル／グループでの @mention を必須にする（デフォルト true）。
- `channels.msteams.replyStyle`: `thread | top-level`（[返信スタイル](#reply-style-threads-vs-posts) を参照）。
- `channels.msteams.teams.<teamId>.replyStyle`: チームごとの上書き。
- `channels.msteams.teams.<teamId>.requireMention`: チームごとの上書き。
- `channels.msteams.teams.<teamId>.toolsBySender`: チームごとの送信者別ツールポリシー上書き（`"*"` ワイルドカード対応）。
- `channels.msteams.teams.<teamId>.toolsBySender`: デフォルトでチームごとに送信者ごとのツールポリシーが上書きされます (`"*"`ワイルドカードがサポートされています)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: チャンネルごとの上書き。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: チャンネルごとの上書き。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: チャンネルごとのツールポリシー上書き（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: チャンネルごとの送信者別ツールポリシー上書き（`"*"` ワイルドカード対応）。
- `channels.msteams.sharePointSiteId`: グループチャット／チャンネルでのファイルアップロード用 SharePoint サイト ID（[グループチャットでのファイル送信](#sending-files-in-group-chats) を参照）。

## ルーティングとセッション

- セッションキーは標準のエージェント形式に従います（[/concepts/session](/concepts/session) を参照）。
  - ダイレクトメッセージはメインセッション（`agent:<agentId>:<mainKey>`）を共有します。
  - チャンネル／グループメッセージは会話 ID を使用します。
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 返信スタイル: Threads vs Posts

Teams では、同一の基盤データモデル上で 2 種類のチャンネル UI スタイルが導入されています。

| スタイル                 | 説明                           | 推奨 `replyStyle` |
| -------------------- | ---------------------------- | --------------- |
| **Posts**（クラシック）     | メッセージがカードとして表示され、下にスレッド返信が付く | `thread`（デフォルト） |
| **Threads**（Slack 風） | メッセージが直線的に流れ、Slack に近い表示     | `top-level`     |

**問題点:** Teams API は、チャンネルがどの UI スタイルを使用しているかを公開していません。誤った `replyStyle` を使用すると: `replyStyle` が間違っている場合:

- Threads スタイルのチャンネルで `thread` → 返信が不自然にネストされます。
- Posts スタイルのチャンネルで `top-level` → 返信がスレッドではなくトップレベル投稿として表示されます。

**解決策:** チャンネルの設定に基づいて、チャンネルごとに `replyStyle` を設定します。

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

**現在の制限:**

- **DM:** Teams ボットのファイル API を介して画像およびファイル添付が動作します。
- **チャンネル／グループ:** 添付は M365 ストレージ（SharePoint／OneDrive）に保存されます。Webhook ペイロードには HTML スタブのみが含まれ、実際のファイルバイトは含まれません。**Graph API 権限が必要** です。 Webhookペイロードは実際のファイルバイトではなく、HTMLスタブのみを含んでいます。 チャンネル添付ファイルをダウンロードするには**Graph APIの権限が必要です**。

グラフの権限がない場合、画像を含むチャネルメッセージはテキストのみとして受信されます (画像コンテンツはボットからアクセスできません)。
デフォルトでは、OpenClawはMicrosoft/Teamsホスト名からメディアをダウンロードするだけです。 `channels.msteams.mediaAllowHosts` で上書きします（`["*"]`を使用してホストを許可します）。
認証ヘッダは `channels.msteams.mediaAuthAllowHosts` のホストに対してのみ付与されます（デフォルトはGraph+Botフレームワークホストです）。 このリストを厳密に保つ（マルチテナントのサフィックスは避ける）。

## グループチャットでのファイル送信

ボットは FileConsentCard フロー（組み込み）を使用して DM でファイルを送信できます。ただし、**グループチャット／チャンネルでのファイル送信** には追加設定が必要です。 しかし、**グループチャット/チャンネルにファイルを送信する**には追加の設定が必要です。

| コンテキスト             | ファイル送信方法                              | 必要な設定                            |
| ------------------ | ------------------------------------- | -------------------------------- |
| **DM**             | FileConsentCard → ユーザー承認 → ボットがアップロード | 箱の外側の作品                          |
| **グループチャット／チャンネル** | SharePoint にアップロード → 共有リンク送信          | `sharePointSiteId` + Graph 権限が必要 |
| **画像（任意のコンテキスト）**  | Base64 エンコードでインライン                    | 箱の外側の作品                          |

### グループチャットで SharePoint が必要な理由

ボットには個人用 OneDrive ドライブがありません（`/me/drive` Graph API エンドポイントはアプリケーション ID では動作しません）。グループチャット／チャンネルでファイルを送信するには、ボットが **SharePoint サイト** にアップロードし、共有リンクを作成します。 グループチャット/チャンネルのファイルを送信するには、ボットが **SharePoint サイト** にアップロードし、共有リンクを作成します。

### セットアップ

1. Entra ID（Azure AD）→ App Registration で **Graph API 権限** を追加します。
   - `Sites.ReadWrite.All`（Application）- SharePoint へのファイルアップロード
   - `Chat.Read.All`（Application）- 任意、ユーザー単位の共有リンクを有効化

2. テナントに **管理者同意** を付与します。

3. **SharePoint サイト ID を取得します。**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw を設定します。**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### 共有動作

| 権限                                      | 共有動作                         |
| --------------------------------------- | ---------------------------- |
| `Sites.ReadWrite.All` のみ                | 組織全体共有リンク（組織内の誰でもアクセス可能）     |
| `Sites.ReadWrite.All` + `Chat.Read.All` | ユーザー単位共有リンク（チャット参加者のみアクセス可能） |

ユーザー単位共有の方が、チャット参加者のみがファイルにアクセスできるため安全です。`Chat.Read.All` 権限がない場合、ボットは組織全体共有にフォールバックします。 `Chat.Read.All` 権限がない場合、ボットは組織全体の共有に戻ります。

### フォールバック動作

| シナリオ                                      | 結果                                    |
| ----------------------------------------- | ------------------------------------- |
| グループチャット + ファイル + `sharePointSiteId` 設定済み | SharePoint にアップロードし、共有リンク送信           |
| グループチャット + ファイル + `sharePointSiteId` なし   | OneDrive アップロードを試行（失敗する場合あり）、テキストのみ送信 |
| 個人チャット + ファイル                             | FileConsentCard フロー（SharePoint 不要）    |
| 任意のコンテキスト + 画像                            | Base64 エンコードでインライン（SharePoint 不要）     |

### ファイルの保存場所

アップロードされたファイルは、設定された SharePoint サイトの既定ドキュメントライブラリ内の `/OpenClawShared/` フォルダーに保存されます。

## 投票（Adaptive Cards）

OpenClaw は Teams の投票を Adaptive Cards として送信します（ネイティブの Teams 投票 API はありません）。

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票結果はゲートウェイによって `~/.openclaw/msteams-polls.json` に記録されます。
- 投票を記録するため、ゲートウェイはオンラインである必要があります。
- 投票結果の自動サマリー投稿は未対応です（必要に応じてストアファイルを確認してください）。

## Adaptive Cards（任意）

`message` ツールまたは CLI を使用して、任意の Adaptive Card JSON を Teams ユーザーまたは会話に送信できます。

`card` パラメータは Adaptive Card の JSON オブジェクトを受け取ります。`card` が指定されている場合、メッセージテキストは省略可能です。 `card`を指定すると、メッセージテキストはオプションです。

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

カードスキーマと例については [Adaptive Cards ドキュメント](https://adaptivecards.io/) を参照してください。ターゲット形式の詳細は下記 [Target formats](#target-formats) を参照してください。 3. ターゲット形式の詳細については、以下の [Target formats](#target-formats) を参照してください。

## ターゲット形式

MSTeams のターゲットは、ユーザーと会話を区別するためにプレフィックスを使用します。

| ターゲット種別         | 形式                               | 例                                            |
| --------------- | -------------------------------- | -------------------------------------------- |
| ユーザー（ID 指定）     | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`  |
| ユーザー（名前指定）      | `user:<display-name>`            | `user:John Smith`（Graph API が必要）             |
| グループ／チャンネル      | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`     |
| グループ／チャンネル（raw） | `<conversation-id>`              | `19:abc123...@thread.tacv2`（`@thread` を含む場合） |

**CLI 例:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**エージェントツール例:**

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

注記: `user:` プレフィックスがない場合、名前はグループ／チーム解決がデフォルトになります。表示名で人を指定する場合は、常に `user:` を使用してください。 表示名で人をターゲットにするときは常に`user`を使います。

## プロアクティブメッセージング

- プロアクティブメッセージは、ユーザーが **一度でも対話した後** にのみ可能です。その時点で会話参照を保存します。
- `dmPolicy` と許可リスト制御については `/gateway/configuration` を参照してください。

## チーム ID とチャンネル ID（よくある落とし穴）

Teams URL の `groupId` クエリパラメータは、設定で使用するチーム ID **ではありません**。URL パスから ID を抽出してください。 代わりにURLパスからIDを抽出:

**チーム URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**チャンネル URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**設定用:**

- チーム ID = `/team/` の後のパスセグメント（URL デコード、例: `19:Bk4j...@thread.tacv2`）
- チャンネル ID = `/channel/` の後のパスセグメント（URL デコード）
- `groupId` クエリパラメータは **無視** してください。

## プライベートチャンネル

ボットのプライベートチャンネル対応には制限があります。

| 機能                     | 標準チャンネル | プライベートチャンネル   |
| ---------------------- | ------- | ------------- |
| ボットのインストール             | はい      | 制限あり          |
| リアルタイムメッセージ（Webhook）   | はい      | 動作しない場合あり     |
| RSC 権限                 | はい      | 挙動が異なる場合あり    |
| @mentions | はい      | ボットがアクセス可能な場合 |
| Graph API 履歴           | はい      | 可（権限が必要）      |

**プライベートチャンネルで動作しない場合の回避策:**

1. ボットとのやり取りには標準チャンネルを使用します。
2. DM を使用します（ユーザーは常にボットに直接メッセージできます）。
3. 履歴アクセスには Graph API を使用します（`ChannelMessage.Read.All` が必要）。

## トラブルシューティング

### よくある問題

- **チャンネルで画像が表示されない:** Graph 権限または管理者同意が不足しています。Teams アプリを再インストールし、Teams を完全に終了／再起動してください。 Teamsアプリを再インストールし、チームを完全に終了/再開します。
- **チャンネルで応答がない:** デフォルトではメンションが必須です。`channels.msteams.requireMention=false` を設定するか、チーム／チャンネルごとに設定してください。
- **バージョン不一致（Teams が古いマニフェストを表示）:** アプリを削除して再追加し、Teams を完全に終了して更新してください。
- **Webhook から 401 Unauthorized:** Azure JWT なしで手動テストした場合に想定される挙動です。エンドポイント到達は確認できていますが、認証に失敗しています。Azure Web Chat を使用して正しくテストしてください。 Azure Web Chat を使用して適切なテストを行います。

### マニフェストアップロードエラー

- **「Icon file cannot be empty」:** マニフェストが 0 バイトのアイコンファイルを参照しています。有効な PNG アイコンを作成してください（`outline.png` 用 32x32、`color.png` 用 192x192）。 有効な PNG アイコン (`outline.png` は 32x32 、`color.png` は 192x192 です) を作成します。
- **「webApplicationInfo.Id already in use」:** アプリが別のチーム／チャットにまだインストールされています。先にアンインストールするか、反映まで 5～10 分待ってください。 最初にそれを見つけてアンインストールするか、伝播のために5-10分待ってください。
- **アップロード時に「Something went wrong」:** 代わりに [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) からアップロードし、ブラウザの DevTools（F12）→ Network タブでレスポンス本文の実際のエラーを確認してください。
- **サイドロード失敗:** 「Upload a custom app」ではなく「Upload an app to your org's app catalog」を試してください。制限を回避できることがあります。

### RSC 権限が動作しない場合

1. `webApplicationInfo.id` がボットの App ID と完全一致していることを確認します。
2. アプリを再アップロードし、チーム／チャットに再インストールします。
3. 組織管理者が RSC 権限をブロックしていないか確認します。
4. 正しいスコープを使用していることを確認します。チームは `ChannelMessage.Read.Group`、グループチャットは `ChatMessage.Read.Chat`。

## 参考資料

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot セットアップガイド
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - Teams アプリの作成／管理
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)（チャンネル／グループには Graph が必要）
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
