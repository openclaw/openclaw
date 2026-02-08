---
summary: "OpenClaw（macOS アプリ）の初回オンボーディングフロー"
read_when:
  - macOS オンボーディングアシスタントの設計時
  - 認証または ID セットアップの実装時
title: "オンボーディング（macOS アプリ）"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:15Z
---

# オンボーディング（macOS アプリ）

本ドキュメントでは、**現在**の初回オンボーディングフローについて説明します。目標は、スムーズな「day 0」体験です。Gateway（ゲートウェイ）の実行場所を選択し、認証を接続し、ウィザードを実行して、エージェントが自己ブートストラップできるようにします。

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
<Step title="ようこそとセキュリティに関する注意">
<Frame caption="表示されるセキュリティに関する注意を読み、内容に応じて判断してください">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="ローカル vs リモート">
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
</Tip>
</Step>
<Step title="権限">
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
<Step title="オンボーディングチャット（専用セッション）">
  セットアップ後、アプリは専用のオンボーディングチャットセッションを開き、エージェントが自己紹介を行い、次のステップを案内します。これにより、初回実行時のガイダンスを通常の会話から分離できます。初回のエージェント実行時にゲートウェイ ホストで何が起こるかについては、[Bootstrapping](/start/bootstrapping) を参照してください。
</Step>
</Steps>
