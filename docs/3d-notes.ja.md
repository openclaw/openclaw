# 3D / R3F ノート

Three.jsを直接使用する（3D-templateのデフォルト）か、React Three FiberをRemotionと組み合わせて使用します。

## アプリごとのインストール（R3F）

```bash
pnpm add three @react-three/fiber @react-three/drei @remotion/three --filter @studio/3d-template
```

## 安定性

- ヘッドレスレンダリング: Remotionのフレームでアニメーションを駆動します（パイプラインでrequestAnimationFrameを避ける）。
- WebGLフラグ: `apps/3D-template/remotion.config.ts` を参照し、必要に応じてCLI経由でChromiumフラグを渡します。

## オプションの合成

`PodcastSlides3D` はオプションのエイリアス `@app/remotion3` を参照します。デフォルトでは無効になっています。エイリアスが有効なアプリの `src/` を指している場合のみ有効にしてください。
