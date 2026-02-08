---
summary: "「openclaw security」の CLI リファレンス（一般的なセキュリティ上の落とし穴の監査と修正）"
read_when:
  - 設定や状態に対して簡易的なセキュリティ監査を実行したい場合
  - 安全な「修正」提案（chmod、既定値の厳格化）を適用したい場合
title: "security"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:14Z
---

# `openclaw security`

セキュリティツール（監査＋任意の修正）。

関連：

- セキュリティガイド： [Security](/gateway/security)

## 監査

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

監査では、複数の DM 送信者がメインセッションを共有している場合に警告を出し、共有受信箱に対して **セキュア DM モード**： `session.dmScope="per-channel-peer"`（またはマルチアカウントチャンネル向けの `per-account-channel-peer`）を推奨します。
また、サンドボックス化されていない状態で Web/ブラウザツールを有効にしたまま小規模モデル（`<=300B`）を使用している場合にも警告します。
