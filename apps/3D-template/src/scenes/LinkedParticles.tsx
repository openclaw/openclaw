import React, { useEffect, useMemo, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { LinkedParticlesSceneManager } from "./LinkedParticlesSceneManager";

type LinkedParticlesProps = {
  showGUI?: boolean;
  seed?: string | number;
};

export const LinkedParticles: React.FC<LinkedParticlesProps> = ({
  showGUI,
  seed,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const frame = useCurrentFrame();
  const videoConfig = useVideoConfig();
  const { fps, width, height } = videoConfig;
  const compositionId =
    (videoConfig as { id?: string }).id ?? "LinkedParticles";
  void showGUI;

  const manager = useMemo(
    () =>
      new LinkedParticlesSceneManager(width, height, { compositionId, seed }),
    [width, height, compositionId, seed],
  );

  useEffect(() => {
    const el = mountRef.current;
    if (!el) {
      return () => {
        manager.dispose();
      };
    }
    manager.mount(el);
    return () => {
      manager.dispose();
    };
  }, [manager]);

  useEffect(() => {
    manager.resize(width, height);
  }, [manager, width, height]);

  useEffect(() => {
    manager.update(frame, fps);
  }, [manager, frame, fps]);

  return (
    <div
      ref={mountRef}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    />
  );
};

export default LinkedParticles;
