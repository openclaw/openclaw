# AItaskLOG - Claude Code Remote Control セットアップ

## 現状

```
$ claude remote-control --name "My Project"
Error: Remote Control is not yet enabled for your account.
```

→ コマンド自体は存在するが、アカウントでまだ有効化されていない状態。

---

## 続きの作業手順 (このエラーの解決)

このエラーは公式ドキュメントの "Remote Control is not yet enabled for your account" に該当する。原因は次のいずれか。

### 1. 環境変数が干渉している (最頻出)

以下の環境変数が設定されていると Remote Control が無効化される。確認して削除する。

```bash
# 現在の設定確認
echo $CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
echo $DISABLE_TELEMETRY
echo $CLAUDE_CODE_USE_BEDROCK
echo $CLAUDE_CODE_USE_VERTEX
echo $CLAUDE_CODE_USE_FOUNDRY
echo $ANTHROPIC_API_KEY

# 設定されていれば解除
unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
unset DISABLE_TELEMETRY
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY
unset ANTHROPIC_API_KEY
```

PowerShell の場合:

```powershell
Remove-Item Env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -ErrorAction SilentlyContinue
Remove-Item Env:DISABLE_TELEMETRY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_USE_BEDROCK -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_USE_VERTEX -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_USE_FOUNDRY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
```

`.bashrc` / `.zshrc` / システム環境変数に永続化されている場合はそちらも削除する。

### 2. ログイン状態をリフレッシュ

API キー認証ではなく claude.ai アカウント認証になっているか確認する。

```bash
claude
```

セッション内で:

```
/logout
/login
```

→ ブラウザが開くので claude.ai でログイン。Pro / Max プランのアカウントを使うこと。

### 3. バージョンを最新にする

Remote Control は v2.1.51 以上が必要。

```bash
claude --version
npm install -g @anthropic-ai/claude-code@latest
claude --version
```

### 4. Team / Enterprise プランの場合

管理者が `https://claude.ai/admin-settings/claude-code` で **Remote Control** トグルを ON にする必要がある。Pro / Max 個人プランなら不要。

### 5. 再実行

```bash
claude remote-control --name "My Project"
```

成功すると URL と (スペースキーで) QR コードが表示される。

---

## チェックリスト

- [ ] `claude --version` が `2.1.51` 以上
- [ ] `ANTHROPIC_API_KEY` 等の環境変数が未設定
- [ ] `claude.ai` アカウントでログイン済 (Pro / Max)
- [ ] `/logout` → `/login` で再認証済
- [ ] 再度 `claude remote-control` でエラーが消えたか

---

## 参考

- 公式ドキュメント: https://code.claude.com/docs/en/remote-control
