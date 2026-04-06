---
read_when:
    - macOS オンボーディングアシスタントを設計する場合
    - 認証またはアイデンティティのセットアップを実装する場合
sidebarTitle: 'Onboarding: macOS App'
summary: OpenClaw の初回セットアップフロー（macOS アプリ）
title: オンボーディング（macOS アプリ）
x-i18n:
    generated_at: "2026-04-02T07:54:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6556aef83f3fcb5bcc28b5e1d1be189c6e861cdca1594bfe72c4394f85c3e6b6
    source_path: start/onboarding.md
    workflow: 15
---

# オンボーディング（macOS アプリ）

このドキュメントでは、**現在の**初回セットアップフローについて説明します。目標はスムーズな「0日目」体験です。Gateway ゲートウェイの実行場所を選択し、認証を接続し、ウィザードを実行して、エージェントが自身をブートストラップできるようにします。
オンボーディングパスの全般的な概要については、[オンボーディング概要](/start/onboarding-overview)を参照してください。

<Steps>
<Step title="macOS の警告を承認">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="ローカルネットワークの検出を承認">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="ウェルカムとセキュリティ通知">
<Frame caption="表示されるセキュリティ通知を読み、適切に判断してください">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

セキュリティ信頼モデル：

- デフォルトでは、OpenClaw はパーソナルエージェントです。信頼されたオペレーターの境界は1つです。
- 共有/マルチユーザーセットアップでは、ロックダウンが必要です（信頼境界を分割し、ツールアクセスを最小限に保ち、[セキュリティ](/gateway/security)に従ってください）。
- ローカルオンボーディングでは、新しい設定のデフォルトが `tools.profile: "coding"` になったため、新規ローカルセットアップでは制限のない `full` プロファイルを強制せずにファイルシステム/ランタイムツールを利用できます。
- フック/Webhook やその他の信頼されていないコンテンツフィードが有効な場合は、強力な最新モデルティアを使用し、厳格なツールポリシー/サンドボックス化を維持してください。

</Step>
<Step title="ローカル vs リモート">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway ゲートウェイ**はどこで実行しますか？

- **この Mac（ローカルのみ）：** オンボーディングで認証を設定し、資格情報をローカルに書き込むことができます。
- **リモート（SSH/Tailnet 経由）：** オンボーディングではローカル認証を設定**しません**。資格情報は Gateway ゲートウェイホストに存在している必要があります。
- **後で設定する：** セットアップをスキップし、アプリを未設定のままにします。

<Tip>
**Gateway ゲートウェイ認証のヒント：**

- ウィザードは loopback でも**トークン**を生成するようになったため、ローカル WS クライアントは認証が必要です。
- 認証を無効にすると、あらゆるローカルプロセスが接続できます。完全に信頼されたマシンでのみ使用してください。
- マルチマシンアクセスや非 loopback バインドには**トークン**を使用してください。

</Tip>
</Step>
<Step title="権限">
<Frame caption="OpenClaw に付与する権限を選択してください">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

オンボーディングでは、以下に必要な TCC 権限をリクエストします：

- オートメーション（AppleScript）
- 通知
- アクセシビリティ
- 画面収録
- マイク
- 音声認識
- カメラ
- 位置情報

</Step>
<Step title="CLI">
  <Info>このステップはオプションです</Info>
  アプリは npm/pnpm 経由でグローバルな `openclaw` CLI をインストールできるため、ターミナルワークフローや launchd タスクがすぐに使用できます。
</Step>
<Step title="オンボーディングチャット（専用セッション）">
  セットアップ後、アプリは専用のオンボーディングチャットセッションを開き、エージェントが自己紹介して次のステップをガイドできるようにします。これにより、初回ガイダンスが通常の会話と分離されます。最初のエージェント実行時に Gateway ゲートウェイホストで何が起こるかについては、[ブートストラップ](/start/bootstrapping)を参照してください。
</Step>
</Steps>
