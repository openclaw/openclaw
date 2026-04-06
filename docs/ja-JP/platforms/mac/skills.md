---
read_when:
    - macOSのSkills設定UIを更新する場合
    - Skillsのゲーティングやインストール動作を変更する場合
summary: macOSのSkills設定UIとGateway ゲートウェイベースのステータス
title: Skills（macOS）
x-i18n:
    generated_at: "2026-04-02T07:48:13Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: dc55cf13ed4ca91ec6a6e6dcca81bcca29d91ae653ced940618ff9575fc2b6fc
    source_path: platforms/mac/skills.md
    workflow: 15
---

# Skills（macOS）

macOSアプリはGateway ゲートウェイを介してOpenClawのSkillsを表示します。ローカルでSkillsの解析は行いません。

## データソース

- `skills.status`（Gateway ゲートウェイ）はすべてのSkillsに加え、適格性と不足している要件を返します
  （バンドルされたSkillsのアローリストブロックを含む）。
- 要件は各 `SKILL.md` の `metadata.openclaw.requires` から導出されます。

## インストールアクション

- `metadata.openclaw.install` はインストールオプション（brew/node/go/uv）を定義します。
- アプリはGateway ゲートウェイホスト上でインストーラーを実行するために `skills.install` を呼び出します。
- 組み込みの危険なコードに対する `critical` 検出はデフォルトで `skills.install` をブロックします。疑わしい検出は警告のみです。危険なオーバーライドはGateway ゲートウェイリクエストに存在しますが、デフォルトのアプリフローはフェイルクローズのままです。
- 複数のインストーラーが提供されている場合、Gateway ゲートウェイは優先される1つのインストーラーのみを表示します
  （利用可能な場合はbrew、そうでなければ `skills.install` からのnodeマネージャー、デフォルトはnpm）。

## 環境変数/APIキー

- アプリはキーを `~/.openclaw/openclaw.json` の `skills.entries.<skillKey>` に保存します。
- `skills.update` は `enabled`、`apiKey`、`env` をパッチします。

## リモートモード

- インストールと設定の更新はGateway ゲートウェイホスト上で行われます（ローカルのMacではありません）。
