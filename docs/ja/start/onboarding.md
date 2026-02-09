---
summary: "OpenClaw（macOS アプリ）の初回オンボーディングフロー"
read_when:
  - macOS オンボーディングアシスタントの設計時
  - 認証または ID セットアップの実装時
title: "オンボーディング（macOS アプリ）"
sidebarTitle: "Onboarding: macOS App"
---

# オンボーディング（macOS アプリ）

このドキュメントでは、最初に実行するオンボーディングフローについて説明します。 本ドキュメントでは、**現在**の初回オンボーディングフローについて説明します。目標は、スムーズな「day 0」体験です。Gateway（ゲートウェイ）の実行場所を選択し、認証を接続し、ウィザードを実行して、エージェントが自己ブートストラップできるようにします。

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="表示されるセキュリティに関する注意を読み、内容に応じて判断してください">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway（ゲートウェイ）** はどこで実行しますか？

- **This Mac（ローカルのみ）:** オンボーディングで OAuth フローを実行し、認証情報をローカルに書き込めます。
- **Remote（SSH/Tailnet 経由）:** オンボーディングではローカルで OAuth を実行**しません**。認証情報はゲートウェイ ホスト上に存在している必要があります。
- **Configure later:** セットアップをスキップし、アプリを未設定のままにします。

<Tip>

**Gateway 認証のヒント:**
- ウィザードは、local loopback の場合でも **トークン** を生成するようになりました。そのため、ローカルの WS クライアントは認証が必要です。
- 認証を無効化すると、任意のローカルプロセスが接続できてしまいます。完全に信頼できるマシンでのみ使用してください。
- 複数マシンからのアクセスや non‑loopback バインドには **トークン** を使用してください。

- authを無効にすると、どのローカルプロセスでも接続できます。完全に信頼されたマシンでのみ使用できます。
- 複数のマシンにアクセスするには、**トークン** を使用します。
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="OpenClaw に付与する権限を選択します">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

オンボーディングでは、以下に必要な TCC 権限を要求します。

- Automation（AppleScript）
- 通知
- アクセシビリティ
- 画面収録
- マイク
- 音声認識
- カメラ
- 位置情報

</Step>
<Step title="CLI">
  <Info>このステップは任意です</Info>
  アプリは、npm/pnpm を通じてグローバルな `openclaw` CLI をインストールできます。これにより、ターミナルのワークフローや launchd タスクがすぐに利用可能になります。
</Step>
<Step title="Onboarding Chat (dedicated session)">
  
  セットアップ後、アプリは専用のオンボーディングチャットセッションを開き、エージェントが自己紹介を行い、次のステップを案内します。これにより、初回実行時のガイダンスを通常の会話から分離できます。初回のエージェント実行時にゲートウェイ ホストで何が起こるかについては、[Bootstrapping](/start/bootstrapping) を参照してください。
 これにより、通常の会話とは別の
  ガイダンスが維持されます。 11. 初回エージェント実行時にゲートウェイホストで何が起こるかについては、
[Bootstrapping](/start/bootstrapping) を参照してください。
</Step>
</Steps>
