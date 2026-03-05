# Remotion Skill Playbook (JA)

このドキュメントは、このモノレポで Remotion 関連タスクを進める際の **Skill-First** 運用ルールです。  
標準スキルは `$remotion-best-practices` とします。

## 基本方針

- まずスキルを適用し、必要なルールだけ読む（全部は読まない）。
- 変更は最小差分で行い、テンプレートと共有パッケージの整合を優先する。
- 仕様判断はこのリポジトリの既存実装とドキュメントを一次情報にする。
- MCP は任意。使わなくても完結できるフローを標準とする。

## スキル更新

- Remotion skills を更新する場合: `pnpm skills:remotion:update`

## 標準フロー

1. タスク開始時に適用スキルを明記する。  
   例: `Using $remotion-best-practices`
2. タスクに必要なルールを選ぶ。  
   例: compositions / assets / calculate-metadata / transitions
3. 実装する。
   - Composition ID
   - `staticFile()` 利用
   - duration/fps/size 整合
4. ローカル検証する。
   - `pnpm remotion versions`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
5. PR で適用ルールをチェックリスト化して提出する。

## タスク別の推奨ルール

- Composition 設計: `rules/compositions.md`
- 動的 duration/サイズ: `rules/calculate-metadata.md`
- 画像/音声/動画: `rules/assets.md`, `rules/videos.md`, `rules/audio.md`
- テキスト演出: `rules/text-animations.md`, `rules/measuring-text.md`
- シーン遷移: `rules/transitions.md`, `rules/sequencing.md`
- 3D: `rules/3d.md`

## PR で最低限確認する項目

- 適用したスキル/ルールが明記されている
- 新規テンプレートで `pnpm create:project` から破綻しない
- Remotion バージョンが catalog で揃っている
- 既存テンプレートの build コマンドが有効
