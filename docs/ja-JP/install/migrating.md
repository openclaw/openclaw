---
read_when:
    - OpenClawを新しいマシンに移動する場合
    - セッション、認証、チャネルのログイン（WhatsAppなど）を保持したい場合
summary: OpenClawのインストールをあるマシンから別のマシンに移行する
title: 移行ガイド
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: faf6102898457e035834ac58030432c69a456a95ac3ae52874528b15d063bfdb
    source_path: install/migrating.md
    workflow: 15
---

# OpenClawを新しいマシンへ移行する

このガイドでは、オンボーディングをやり直すことなく、OpenClaw Gateway ゲートウェイを新しいマシンに移動します。

## 移行されるもの

**状態ディレクトリ**（デフォルト`~/.openclaw/`）と**ワークスペース**をコピーすると、以下が保持されます：

- **設定** -- `openclaw.json`とすべてのGateway ゲートウェイ設定
- **認証** -- APIキー、OAuthトークン、認証情報プロファイル
- **セッション** -- 会話履歴とエージェント状態
- **チャネル状態** -- WhatsAppログイン、Telegramセッションなど
- **ワークスペースファイル** -- `MEMORY.md`、`USER.md`、スキル、プロンプト

<Tip>
古いマシンで`openclaw status`を実行して状態ディレクトリのパスを確認してください。
カスタムプロファイルは`~/.openclaw-<profile>/`または`OPENCLAW_STATE_DIR`で設定されたパスを使用します。
</Tip>

## 移行手順

<Steps>
  <Step title="Gateway ゲートウェイを停止してバックアップを作成">
    **古い**マシンで、ファイルがコピー中に変更されないようにGateway ゲートウェイを停止してからアーカイブを作成：

    ```bash
    openclaw gateway stop
    cd ~
    tar -czf openclaw-state.tgz .openclaw
    ```

    複数のプロファイル（例：`~/.openclaw-work`）を使用している場合は、それぞれ個別にアーカイブしてください。

  </Step>

  <Step title="新しいマシンにOpenClawをインストール">
    新しいマシンに[インストール](/install)CLIをインストールします（必要に応じてNodeも）。
    オンボーディングで新しい`~/.openclaw/`が作成されても問題ありません。次のステップで上書きします。
  </Step>

  <Step title="状態ディレクトリとワークスペースをコピー">
    `scp`、`rsync -a`、または外付けドライブでアーカイブを転送し、展開：

    ```bash
    cd ~
    tar -xzf openclaw-state.tgz
    ```

    隠しディレクトリが含まれていること、およびファイルの所有者がGateway ゲートウェイを実行するユーザーと一致していることを確認してください。

  </Step>

  <Step title="doctorを実行して確認">
    新しいマシンで[Doctor](/gateway/doctor)を実行して設定の移行を適用し、サービスを修復：

    ```bash
    openclaw doctor
    openclaw gateway restart
    openclaw status
    ```

  </Step>
</Steps>

## よくある落とし穴

<AccordionGroup>
  <Accordion title="プロファイルまたは状態ディレクトリの不一致">
    古いGateway ゲートウェイが`--profile`または`OPENCLAW_STATE_DIR`を使用していて新しいマシンでは使用していない場合、
    チャネルはログアウト状態に見え、セッションは空になります。
    移行した同じプロファイルまたは状態ディレクトリでGateway ゲートウェイを起動してから`openclaw doctor`を再実行してください。
  </Accordion>

  <Accordion title="openclaw.jsonのみをコピーした場合">
    設定ファイルだけでは不十分です。認証情報は`credentials/`以下にあり、
    エージェントの状態は`agents/`以下にあります。常に**状態ディレクトリ全体**を移行してください。
  </Accordion>

  <Accordion title="パーミッションと所有権">
    rootとしてコピーしたり、ユーザーを切り替えた場合、Gateway ゲートウェイが認証情報を読み取れない場合があります。
    状態ディレクトリとワークスペースがGateway ゲートウェイを実行するユーザーの所有であることを確認してください。
  </Accordion>

  <Accordion title="リモートモード">
    UIが**リモート**Gateway ゲートウェイを指している場合、リモートホストがセッションとワークスペースを所有しています。
    ローカルのノートPCではなく、Gateway ゲートウェイホスト自体を移行してください。[FAQ](/help/faq#where-things-live-on-disk)を参照。
  </Accordion>

  <Accordion title="バックアップ内のシークレット">
    状態ディレクトリにはAPIキー、OAuthトークン、チャネルの認証情報が含まれています。
    バックアップは暗号化して保存し、安全でない転送チャネルを避け、漏洩が疑われる場合はキーをローテーションしてください。
  </Accordion>
</AccordionGroup>

## 確認チェックリスト

新しいマシンで以下を確認：

- [ ] `openclaw status`でGateway ゲートウェイが実行中であることを確認
- [ ] チャネルが引き続き接続されている（再ペアリング不要）
- [ ] ダッシュボードが開き、既存のセッションが表示される
- [ ] ワークスペースファイル（メモリ、設定）が存在する
