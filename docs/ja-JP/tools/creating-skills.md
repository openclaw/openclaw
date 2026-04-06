---
read_when:
    - ワークスペースに新しいカスタム Skills を作成する場合
    - SKILL.md ベースの Skills のクイックスターターワークフローが必要な場合
summary: SKILL.md を使ってカスタムワークスペース Skills をビルド・テストする
title: Skills の作成
x-i18n:
    generated_at: "2026-04-02T09:00:58Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8c376aa6414b5c026cee94f4f50520dc33a9e0fc10d4117e43d7d3737fc0446d
    source_path: tools/creating-skills.md
    workflow: 15
---

# Skills の作成

Skills はエージェントにツールの使い方と使うタイミングを教えます。各 Skills は、YAML フロントマターと Markdown の説明を含む `SKILL.md` ファイルが入ったディレクトリです。

Skills の読み込みと優先順位については、[Skills](/tools/skills) を参照してください。

## 最初の Skills を作成する

<Steps>
  <Step title="Skills ディレクトリを作成する">
    Skills はワークスペースに配置します。新しいフォルダを作成してください：

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/hello-world
    ```

  </Step>

  <Step title="SKILL.md を記述する">
    そのディレクトリ内に `SKILL.md` を作成します。フロントマターでメタデータを定義し、Markdown 本文にエージェントへの指示を記述します。

    ```markdown
    ---
    name: hello_world
    description: A simple skill that says hello.
    ---

    # Hello World Skill

    When the user asks for a greeting, use the `echo` tool to say
    "Hello from your custom skill!".
    ```

  </Step>

  <Step title="ツールを追加する（任意）">
    フロントマターでカスタムツールスキーマを定義したり、既存のシステムツール（`exec` や `browser` など）を使うようエージェントに指示できます。Skills はプラグインの中にツールと一緒にパッケージすることもできます。

  </Step>

  <Step title="Skills を読み込む">
    新しいセッションを開始して OpenClaw に Skills を認識させます：

    ```bash
    # チャットから
    /new

    # またはゲートウェイを再起動
    openclaw gateway restart
    ```

    Skills が読み込まれたことを確認します：

    ```bash
    openclaw skills list
    ```

  </Step>

  <Step title="テストする">
    Skills をトリガーするメッセージを送信します：

    ```bash
    openclaw agent --message "give me a greeting"
    ```

    または、エージェントとチャットして挨拶をリクエストしてください。

  </Step>
</Steps>

## Skills メタデータリファレンス

YAML フロントマターは以下のフィールドをサポートしています：

| フィールド                            | 必須 | 説明                                        |
| ----------------------------------- | ---- | ------------------------------------------- |
| `name`                              | はい | 一意の識別子（snake_case）                    |
| `description`                       | はい | エージェントに表示される一行の説明              |
| `metadata.openclaw.os`              | いいえ | OS フィルター（`["darwin"]`、`["linux"]` など） |
| `metadata.openclaw.requires.bins`   | いいえ | PATH 上に必要なバイナリ                       |
| `metadata.openclaw.requires.config` | いいえ | 必要な設定キー                                |

## ベストプラクティス

- **簡潔に** — モデルに _何をすべきか_ を指示し、AI としての振る舞い方は指示しない
- **安全第一** — Skills が `exec` を使う場合、信頼されていない入力からの任意のコマンドインジェクションを許さないようプロンプトを確認する
- **ローカルでテスト** — 共有する前に `openclaw agent --message "..."` でテストする
- **ClawHub を活用** — [ClawHub](https://clawhub.com) で Skills を閲覧・共有する

## Skills の配置場所

| 場所                            | 優先順位 | スコープ              |
| ------------------------------- | -------- | --------------------- |
| `\<workspace\>/skills/`         | 最高     | エージェントごと       |
| `~/.openclaw/skills/`           | 中       | 共有（全エージェント） |
| バンドル（OpenClaw に同梱）       | 最低     | グローバル             |
| `skills.load.extraDirs`         | 最低     | カスタム共有フォルダ    |

## 関連項目

- [Skills リファレンス](/tools/skills) — 読み込み、優先順位、ゲーティングルール
- [Skills 設定](/tools/skills-config) — `skills.*` 設定スキーマ
- [ClawHub](/tools/clawhub) — 公開 Skills レジストリ
- [プラグインのビルド](/plugins/building-plugins) — プラグインに Skills を同梱できます
