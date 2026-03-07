/**
 * BackgroundLayerStack — Composable background layers driven by spec.
 *
 * Layer types:
 * - softGradient: radial gradient with slow drift animation
 * - grain: subtle noise overlay
 * - vignette: radial edge darkening
 * - greenBloom: soft green glow with optional pulse
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import { MotionSpec, BackgroundLayer } from "../parser/MotionSpecTypes";

function defaultLayers(spec: MotionSpec): BackgroundLayer[] {
  const layers: BackgroundLayer[] = [
    { type: "softGradient", opacity: 0.35, animate: "slowDrift" },
  ];
  if (spec.style.grain > 0) {
    layers.push({ type: "grain", opacity: spec.style.grain });
  }
  if (spec.style.vignette) {
    layers.push({ type: "vignette", opacity: 0.55 });
  }
  return layers;
}

const LayerRenderer: React.FC<{
  layer: BackgroundLayer;
  frame: number;
  green: string;
}> = ({ layer, frame, green }) => {
  switch (layer.type) {
    case "softGradient": {
      const driftX = Math.sin(frame / 120) * 20;
      const driftY = Math.cos(frame / 160) * 16;
      return (
        <div
          style={{
            position: "absolute",
            inset: -200,
            zIndex: 0,
            opacity: layer.opacity,
            transform: layer.animate === "slowDrift"
              ? `translate(${driftX}px, ${driftY}px)`
              : undefined,
            background: `radial-gradient(circle at 50% 30%, ${green}38, transparent 55%),
                         radial-gradient(circle at 20% 80%, rgba(255,255,255,0.06), transparent 50%),
                         linear-gradient(180deg, #0B0B0F 0%, #0E1016 100%)`,
          }}
        />
      );
    }

    case "grain":
      return (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            opacity: layer.opacity,
            backgroundImage: `repeating-linear-gradient(
              0deg,
              transparent,
              transparent 1px,
              rgba(255,255,255,0.015) 1px,
              rgba(255,255,255,0.015) 2px
            ), repeating-linear-gradient(
              90deg,
              transparent,
              transparent 1px,
              rgba(255,255,255,0.01) 1px,
              rgba(255,255,255,0.01) 2px
            )`,
            transform: `translateY(${Math.sin(frame * 0.5) * 1}px)`,
          }}
        />
      );

    case "vignette":
      return (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            opacity: layer.opacity,
            background:
              "radial-gradient(circle at 50% 50%, transparent 55%, rgba(0,0,0,0.6) 100%)",
          }}
        />
      );

    case "greenBloom": {
      const pulseScale = layer.pulse === "subtle" || layer.animate === "pulse"
        ? 1 + Math.sin(frame * 0.04) * 0.08
        : 1;
      return (
        <div
          style={{
            position: "absolute",
            inset: -300,
            zIndex: 0,
            opacity: layer.opacity,
            background: `radial-gradient(circle at 50% 40%, ${green}30, transparent 60%)`,
            transform: `scale(${pulseScale})`,
            filter: "blur(60px)",
          }}
        />
      );
    }

    default:
      return null;
  }
};

export const BackgroundLayerStack: React.FC<{ spec: MotionSpec }> = ({
  spec,
}) => {
  const frame = useCurrentFrame();
  const layers = spec.backgroundLayers ?? defaultLayers(spec);

  return (
    <>
      {layers.map((layer, i) => (
        <LayerRenderer
          key={`${layer.type}-${i}`}
          layer={layer}
          frame={frame}
          green={spec.style.green}
        />
      ))}
    </>
  );
};
