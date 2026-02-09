---
summary: "npm + macOS アプリ向けのステップバイステップなリリースチェックリスト"
read_when:
  - 新しい npm リリースを作成する際
  - 新しい macOS アプリリリースを作成する際
  - 公開前にメタデータを検証する際
---

# リリースチェックリスト（npm + macOS）

リポジトリの `pnpm` (ノード22+) を使用します。 リポジトリのルートから `pnpm`（Node 22+）を使用します。タグ付けや公開の前に、作業ツリーがクリーンであることを保ってください。

## オペレータートリガー

オペレーターが「release」と言ったら、直ちに次の事前確認を実行します（ブロックされない限り、追加の質問はしないでください）。

- このドキュメントと `docs/platforms/mac/release.md` を読む。
- `~/.profile` から env を読み込み、`SPARKLE_PRIVATE_KEY_FILE` と App Store Connect の変数が設定されていることを確認します（SPARKLE_PRIVATE_KEY_FILE は `~/.profile` に配置されている必要があります）。
- 必要に応じて `~/Library/CloudStorage/Dropbox/Backup/Sparkle` の Sparkle キーを使用します。

1. **バージョン & メタデータ**

- [ ] `package.json` のバージョンを更新します（例: `2026.1.29`）。
- [ ] `pnpm plugins:sync` を実行して、拡張パッケージのバージョンと changelog を整合させます。
- [ ] CLI / バージョン文字列を更新します: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) と [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) の Baileys ユーザーエージェント。
- [ ] パッケージメタデータ（name、description、repository、keywords、license）を確認し、`bin` のマップが `openclaw` 向けに [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) を指していることを確認します。
- [ ] 依存関係を変更した場合は、`pnpm install` を実行して `pnpm-lock.yaml` が最新であることを確認します。

2. **ビルド & 成果物**

- [ ] A2UI の入力が変更された場合は、`pnpm canvas:a2ui:bundle` を実行し、更新された [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) をコミットします。
- [ ] `pnpm run build`（`dist/` を再生成します）。
- [ ] npm パッケージ `files` に、必要な `dist/*` フォルダーがすべて含まれていることを確認します（特にヘッドレス node + ACP CLI 用の `dist/node-host/**` と `dist/acp/**`）。
- [ ] `dist/build-info.json` が存在し、期待される `commit` ハッシュが含まれていることを確認します（CLI バナーは npm インストール時にこれを使用します）。
- [ ] 任意: ビルド後に `npm pack --pack-destination /tmp` を実行します。tarball の内容を確認し、GitHub リリース用に手元に保持します（**コミットしないでください**）。

3. **Changelog & ドキュメント**

- [ ] `CHANGELOG.md` をユーザー向けのハイライトで更新します（存在しない場合は作成します）。エントリはバージョンの降順を厳守してください。
- [ ] README の例やフラグが、現在の CLI の挙動（特に新しいコマンドやオプション）と一致していることを確認します。

4. **検証**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test`（カバレッジ出力が必要な場合は `pnpm test:coverage`）
- [ ] `pnpm release:check`（npm pack の内容を検証します）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker インストールのスモークテスト、ファストパス。リリース前に必須）
  - 直前の npm リリースが既知の不具合を含む場合は、事前インストール手順のために `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` または `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` を設定します。
- [ ] （任意）フルインストーラーのスモーク（非 root + CLI のカバレッジを追加）: `pnpm test:install:smoke`
- [ ] （任意）インストーラー E2E（Docker、`curl -fsSL https://openclaw.ai/install.sh | bash` を実行し、オンボーディング後に実際のツール呼び出しを実行）:
  - `pnpm test:install:e2e:openai`（`OPENAI_API_KEY` が必要）
  - `pnpm test:install:e2e:anthropic`（`ANTHROPIC_API_KEY` が必要）
  - `pnpm test:install:e2e`（両方のキーが必要。両プロバイダーを実行）
- [ ] （任意）変更が送受信パスに影響する場合は、Web ゲートウェイをスポットチェックします。

5. **macOS アプリ（Sparkle）**

- [ ] macOS アプリをビルドして署名し、配布用に zip 化します。
- [ ] Sparkle の appcast を生成（[`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) による HTML ノート）し、`appcast.xml` を更新します。
- [ ] GitHub リリースに添付できるよう、アプリの zip（および任意の dSYM zip）を用意します。
- [ ] 正確なコマンドと必要な env 変数については [macOS release](/platforms/mac/release) に従ってください。
  - `APP_BUILD` は数値かつ単調増加である必要があります（`-beta` は不可）。これにより Sparkle がバージョンを正しく比較します。
  - 公証する場合は、App Store Connect API の env 変数から作成した `openclaw-notary` のキーチェーンプロファイルを使用します（[macOS release](/platforms/mac/release) を参照）。

6. **公開（npm）**

- [ ] git の状態がクリーンであることを確認し、必要に応じてコミットと push を行います。
- [ ] 必要に応じて `npm login`（2FA の確認）。
- [ ] `npm publish --access public`（プレリリースには `--tag beta` を使用）。
- [ ] レジストリを確認します: `npm view openclaw version`、`npm view openclaw dist-tags`、`npx -y openclaw@X.Y.Z --version`（または `--help`）。

### トラブルシューティング（2.0.0-beta2 リリース時のメモ）

- **npm pack / publish がハングする、または巨大な tarball を生成する**: `dist/OpenClaw.app` 内の macOS アプリバンドル（およびリリース zip）がパッケージに取り込まれています。`package.json` `files` によって公開内容をホワイトリスト化して修正します（dist サブディレクトリ、docs、skills を含め、アプリバンドルを除外）。`npm pack --dry-run` で `dist/OpenClaw.app` が一覧に含まれていないことを確認してください。 `package.json` `files` で公開内容をホワイトリストに追加して修正しました（ディストのサブディレクトリ、ドキュメント、スキル、アプリのバンドルを除く）。 `dist/OpenClaw.app`がリストされていない`npm pack --dry-run`で確認します。
- **dist-tags の npm auth web ループ**: OTP プロンプトを表示するため、レガシー認証を使用します:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` の検証が `ECOMPROMISED: Lock compromised` で失敗する**: 新しいキャッシュで再試行します:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **遅れた修正後にタグの付け替えが必要**: タグを強制更新して push し、GitHub リリースのアセットが引き続き一致していることを確認します:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub リリース + appcast**

- [ ] タグ付けして push: `git tag vX.Y.Z && git push origin vX.Y.Z`（または `git push --tags`）。
- [ ] `vX.Y.Z` の GitHub リリースを作成または更新し、**タイトルは `openclaw X.Y.Z`**（タグ名のみは不可）にします。本文には、そのバージョンの **完全な** changelog セクション（Highlights + Changes + Fixes）をインラインで含め（リンクのみは不可）、**本文内でタイトルを繰り返してはいけません**。
- [ ] 成果物を添付します: `npm pack` の tarball（任意）、`OpenClaw-X.Y.Z.zip`、`OpenClaw-X.Y.Z.dSYM.zip`（生成している場合）。
- [ ] 更新された `appcast.xml` をコミットして push します（Sparkle は main からフィードします）。
- [ ] クリーンな一時ディレクトリ（`package.json` なし）から `npx -y openclaw@X.Y.Z send --help` を実行し、インストール / CLI のエントリポイントが動作することを確認します。
- [ ] リリースノートを告知 / 共有します。

## プラグインの公開スコープ（npm）

**既存の npm プラグイン** を `@openclaw/*` スコープにのみ公開します。 公開するのは `@openclaw/*` スコープ配下の **既存の npm プラグイン** のみです。npm に存在しない同梱プラグインは **ディスクツリーのみ** に留めます（引き続き `extensions/**` に同梱されます）。

リストを導出する手順:

1. `npm search @openclaw --json` を実行し、パッケージ名を取得します。
2. `extensions/*/package.json` の名前と比較します。
3. **共通部分**（すでに npm に存在するもの）のみを公開します。

現在の npm プラグイン一覧（必要に応じて更新）:

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

リリースノートでは、**デフォルトでは有効でない** **新しい任意の同梱プラグイン**（例: `tlon`）についても必ず言及してください。
