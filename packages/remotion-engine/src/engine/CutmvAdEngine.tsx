import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { MotionSpec, EnhancedTransitionSpec } from "./parser/MotionSpecTypes";
import { SceneComposer } from "./SceneComposer";
import { CaptionSystem } from "./captions/CaptionSystem";
import { BackgroundLayerStack } from "./background/BackgroundLayerStack";
import { TransitionOverlay, legacyToEnhanced } from "./transitions/TransitionOverlay";
import { applyTransitionGuard } from "./transitions/transitionGuard";
import { BrandSystemOverlay } from "./overlays/BrandSystemOverlay";
import { GlobalCursorOverlay } from "./overlays/GlobalCursorOverlay";
import { EnvironmentLayerStack } from "./environment/EnvironmentLayer";

// ── TransitionLayer: renders all scene transitions at z-index 50 ──
const TransitionLayer: React.FC<{ spec: MotionSpec }> = ({ spec }) => {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 50, pointerEvents: "none" }}>
      {spec.scenes.map((scene) => {
        // Resolve enhanced transition: prefer enhancedTransitionOut, fall back to legacy
        const rawTrans: EnhancedTransitionSpec | null =
          scene.enhancedTransitionOut ??
          (scene.transitionOut ? legacyToEnhanced(scene.transitionOut) : null);

        if (!rawTrans) return null;

        // Anti-jank: reduce blur/bloom on busy environments (premiere_timeline, etc.)
        const trans = applyTransitionGuard(rawTrans, scene);

        const transFrom = scene.from + scene.duration - trans.duration;
        return (
          <Sequence
            key={`trans-out-${scene.id}`}
            from={transFrom}
            durationInFrames={trans.duration}
          >
            <TransitionOverlay
              spec={trans}
              green={spec.style.green}
              width={spec.width}
              height={spec.height}
            />
          </Sequence>
        );
      })}

      {/* transitionIn for scenes that have it */}
      {spec.scenes.map((scene) => {
        if (!scene.transitionIn) return null;
        return (
          <Sequence
            key={`trans-in-${scene.id}`}
            from={scene.from}
            durationInFrames={scene.transitionIn.duration}
          >
            <TransitionOverlay
              spec={scene.transitionIn}
              green={spec.style.green}
              width={spec.width}
              height={spec.height}
            />
          </Sequence>
        );
      })}
    </div>
  );
};

export const CutmvAdEngine: React.FC<{ spec: MotionSpec }> = ({ spec }) => {
  return (
    <AbsoluteFill style={{ background: spec.style.black, overflow: "hidden" }}>
      {/* ── Z-INDEX 0: Background layers ── */}
      <BackgroundLayerStack spec={spec} />

      {/* ── Z-INDEX 5: Environment layers (premiere timeline, abstract, etc.) ── */}
      <EnvironmentLayerStack
        scenes={spec.scenes}
        width={spec.width}
        height={spec.height}
        green={spec.style.green}
        totalFrames={spec.durationInFrames}
        brandSystem={spec.brandSystem}
      />

      {/* ── Z-INDEX 10: Scene content (no transitions) ── */}
      <SceneComposer spec={spec} />

      {/* ── Z-INDEX 50: Transitions (rendered at engine level) ── */}
      <TransitionLayer spec={spec} />

      {/* ── Z-INDEX 90: Global cursor overlay ── */}
      <GlobalCursorOverlay spec={spec} />

      {/* ── Z-INDEX 80: Captions ── */}
      {spec.captions ? (
        <div style={{ position: "absolute", inset: 0, zIndex: 80 }}>
          <CaptionSystem captions={spec.captions} green={spec.style.green} />
        </div>
      ) : null}

      {/* ── Z-INDEX 9999: Brand system (bug + hero bookends + endcard lockup) ── */}
      <BrandSystemOverlay spec={spec} />
    </AbsoluteFill>
  );
};
