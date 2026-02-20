# 2026-02-20 VRChat Relay Plugin PR 送付

## 概要

`extensions/vrchat-relay/` ディレクトリの VRChat OSC プラグインを公式リポジトリ (`openclaw/openclaw`) に PR として送付した。

## PR 情報

- **PR URL**: https://github.com/openclaw/openclaw/pull/21707
- **状態**: Draft（レビュー待ち）
- **送付元ブランチ**: `zapabob:feat/vrchat-relay-osc`
- **送付先**: `openclaw/openclaw:main`

## 作業手順

```bash
# 1. PR専用ブランチをupstream/mainから作成
git checkout -b feat/vrchat-relay-osc upstream/main

# 2. VRChatコミットだけをcherry-pick
git cherry-pick 68ee6b94b   # feat: add VRChat relay extension
git cherry-pick 2b6f75c3f   # chore: update pnpm-lock (conflict→THEIRS)

# 3. originにpush
git push origin feat/vrchat-relay-osc

# 4. gh CLIでドラフトPR作成
gh pr create --repo openclaw/openclaw \
  --head "zapabob:feat/vrchat-relay-osc" \
  --base main --draft \
  --title "feat: add VRChat relay extension with OSC protocol support"
```

## 含まれる変更

- `extensions/vrchat-relay/index.ts` (21KB)
- `extensions/vrchat-relay/package.json`
- `extensions/vrchat-relay/openclaw.plugin.json`
- `extensions/vrchat-relay/README.md`
- `extensions/vrchat-relay/src/` (osc/, auth/, tools/ 全サブモジュール)

## 重要事項

- 他の独自変更（self-evolution, self-repair, .envのモデル設定等）はPRに含まれていない
- upstream/mainをベースにcherry-pickしたため、差分は最小限
- ドラフト状態のため、公式レビューを受けてからドラフト解除すること
