---
summary: "OpenClawの初回オンボーディングフロー（macOSアプリ）"
read_when:
  - macOSオンボーディングアシスタントを設計する
  - 認証やID設定を実装する
title: "オンボーディング（macOSアプリ）"
sidebarTitle: "オンボーディング: macOSアプリ"
---

# オンボーディング（macOSアプリ）

このドキュメントでは、**現在の**初回オンボーディングフローについて説明します。目標はスムーズな「0日目」体験です：Gatewayの実行場所を選択し、認証を接続し、ウィザードを実行し、エージェントが自身をブートストラップできるようにします。
オンボーディングパスの概要については、[オンボーディング概要](/start/onboarding-overview)をご覧ください。

<Steps>
<Step title="macOSの警告を承認">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="ローカルネットワーク検索を承認">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="ようこそ画面とセキュリティ通知">
<Frame caption="表示されたセキュリティ通知を読んで、適宜判断してください">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

セキュリティ信頼モデル:

- デフォルトでは、OpenClawはパーソナルエージェントです：1つの信頼されたオペレーター境界。
- 共有/マルチユーザーセットアップには、ロックダウンが必要です（信頼境界を分離し、ツールアクセスを最小限に保ち、[セキュリティ](/gateway/security)に従ってください）。

</Step>
<Step title="ローカル vs リモート">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway**はどこで実行しますか？

- **このMac（ローカルのみ）:** オンボーディングでローカルに認証を設定し、クレデンシャルを書き込むことができます。
- **リモート（SSH/Tailnet経由）:** オンボーディングではローカル認証を設定**しません**。クレデンシャルはGatewayホスト上に存在する必要があります。
- **後で設定:** セットアップをスキップし、アプリを未設定のままにします。

<Tip>
**Gateway認証のヒント:**

- ウィザードはループバックでも**トークン**を生成するようになったため、ローカルWSクライアントも認証が必要です。
- 認証を無効にすると、任意のローカルプロセスが接続できます。完全に信頼されたマシンでのみ使用してください。
- マルチマシンアクセスや非ループバックバインドには**トークン**を使用してください。

</Tip>
</Step>
<Step title="パーミッション">
<Frame caption="OpenClawに付与するパーミッションを選択してください">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

オンボーディングでは以下に必要なTCCパーミッションをリクエストします：

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
  アプリはnpm/pnpm経由でグローバルな `openclaw` CLIをインストールできるため、ターミナルワークフローやlaunchdタスクがすぐに使えます。
</Step>
<Step title="オンボーディングチャット（専用セッション）">
  セットアップ後、アプリは専用のオンボーディングチャットセッションを開き、エージェントが自己紹介し、次のステップをガイドします。これにより、初回ガイダンスを通常の会話と分離できます。Gatewayホストでの初回エージェント実行時の動作については、[ブートストラップ](/ja-JP/start/bootstrapping)をご覧ください。
</Step>
</Steps>
