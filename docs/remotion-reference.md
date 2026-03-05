# Remotion Reference

## 主要リンク

- Docs（総合）: https://www.remotion.dev/docs
- API: https://www.remotion.dev/docs/api
- Troubleshooting: https://www.remotion.dev/docs/troubleshooting
- CLI: https://www.remotion.dev/docs/cli

## API ピンポイント（最小要約＋出典）

- useCurrentFrame: 現在のフレーム番号を取得（アニメや補間の基点）
  - 出典: https://www.remotion.dev/docs/use-current-frame
- useVideoConfig: width/height/fps/duration を取得
  - 出典: https://www.remotion.dev/docs/use-video-config
- Composition: コンポジションを登録（id, component, duration など）
  - 出典: https://www.remotion.dev/docs/composition
- Sequence: 指定区間のみ子を表示（from, duration）
  - 出典: https://www.remotion.dev/docs/sequence
- spring / interpolate: 物理ベース/補間ユーティリティ
  - 出典: https://www.remotion.dev/docs/spring / https://www.remotion.dev/docs/interpolate
- AbsoluteFill: 全面レイアウトのショートカット
  - 出典: https://www.remotion.dev/docs/absolute-fill

## トラブルシューティング（最小）

- Composition ID 不一致 → 指定した ID と Composition の `id` を一致させる
  - 出典: https://www.remotion.dev/docs/troubleshooting
- `window is not defined` → ブラウザ環境前提の参照を避ける/ガードを入れる
  - 出典: https://www.remotion.dev/docs/troubleshooting
- アセット 404 → `public/` 配下＋ `staticFile()` を使用
  - 出典: https://www.remotion.dev/docs/staticfile

## レンダリング / ブラウザ

- レンダリング: `remotion render`
  - 出典: https://www.remotion.dev/docs/cli/render
- Chromium の指定（環境変数/引数）
  - 出典: https://www.remotion.dev/docs/chromium#specifying-a-custom-executable
- Chrome for Testing / Headless Shell の導入
  - 出典: https://www.remotion.dev/docs/chromium

## Disclaimers

This repository provides templates and scripts only.
It does not redistribute the Remotion software.
Users install Remotion via npm (e.g. pnpm i remotion @remotion/cli).
This project is unofficial and not affiliated with or endorsed by Remotion.
For Remotion’s license & terms, see the official docs.

（日本語版）

このリポジトリはテンプレート／スクリプトのみを提供します。
Remotion本体の同梱・再配布は行いません（利用者が pnpm i remotion @remotion/cli 等で導入）。
本プロジェクトは非公式であり、Remotionの提携・公認ではありません。
ライセンスと規約は必ず公式ドキュメントをご確認ください。
companies.remotion.dev
