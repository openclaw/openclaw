import { useEffect, useRef, useCallback } from "react";
import { usePixiApp } from "../hooks/usePixiApp";
import { useEmpireState } from "../state/useEmpireState";
import { BioCorpusScene } from "../pixi/biocorpus/BioCorpusScene";

export function BioCorpusVisualizer() {
  const { containerRef, app } = usePixiApp();
  const { raw } = useEmpireState();
  const sceneRef = useRef<BioCorpusScene | null>(null);
  const dataRef = useRef(raw);
  dataRef.current = raw;

  useEffect(() => {
    if (!app) return;

    const scene = new BioCorpusScene();
    sceneRef.current = scene;
    app.stage.addChild(scene);

    const resize = () => {
      const w = app.screen.width;
      const h = app.screen.height;
      if (w > 0 && h > 0) {
        scene.resize(w, h);
      }
    };
    requestAnimationFrame(resize);
    app.renderer.on("resize", resize);

    const tickerFn = (ticker: { deltaMS: number }) => {
      scene.update(dataRef.current, ticker.deltaMS);
    };
    app.ticker.add(tickerFn);

    return () => {
      app.renderer.off("resize", resize);
      app.ticker.remove(tickerFn);
      app.stage.removeChild(scene);
      sceneRef.current = null;
    };
  }, [app]);

  return (
    <div
      style={{
        width: "100%",
        height: "100dvh",
        position: "fixed",
        top: 0,
        left: 0,
        overflow: "hidden",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
