# 依存関係の追加

このモノレポでパッケージをインストールするためのガイドラインです。

## アプリごとのインストール

1つのアプリにのみ依存関係をインストールする場合：

```bash
pnpm add <pkg> --filter @studio/<app>
pnpm add -D @types/<pkg> --filter @studio/<app>
```

## 複数のアプリ

必要な各アプリに個別に追加します（テンプレートは最小限に保ちます）。

## 共有パッケージ

デフォルトでは使用されません。必要に応じて `packages/` 配下に作成し、ワークスペースに含めます。

## ピア依存関係（重要）

- 2D (Pixi/Konva): `pixi.js`, `konva`
- 3D (R3F): `three`, `@react-three/fiber`, `@react-three/drei`, `@remotion/three`

これらを使用するアプリにインストールしてください。
