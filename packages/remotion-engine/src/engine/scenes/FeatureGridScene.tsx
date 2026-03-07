import React from "react";
import { useCurrentFrame } from "remotion";
import { FeatureGridScene as FeatureGridSceneType } from "../parser/MotionSpecTypes";
import { SafeZone } from "../layout/SafeZone";
import { NoOverlapStack } from "../layout/NoOverlapStack";

const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));

// Simple icon map (green accent shapes)
const iconMap: Record<string, string> = {
  bolt: "\u26A1",
  spark: "\u2728",
  frame: "\uD83D\uDDBC\uFE0F",
  loop: "\uD83D\uDD01",
};

export const FeatureGridRenderer: React.FC<{
  scene: FeatureGridSceneType;
  green: string;
}> = ({ scene, green }) => {
  const frame = useCurrentFrame();
  const stagger = scene.motion?.staggerFrames ?? 6;
  const cols = scene.layout?.columns ?? 2;
  const maxW = scene.layout?.maxWidthPx ?? 940;

  return (
    <SafeZone>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <NoOverlapStack maxWidth={maxW} gap={24}>
          {/* Title */}
          <div
            style={{
              fontSize: 64,
              fontWeight: 1000,
              color: scene.title.emphasis ? green : "white",
              textAlign: "center",
            }}
          >
            {scene.title.text}
          </div>

          {/* Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: 20,
              width: "100%",
            }}
          >
            {scene.items.map((item, i) => {
              const t = clamp((frame - i * stagger) / 12, 0, 1);
              const ease = 1 - Math.pow(1 - t, 3);
              return (
                <div
                  key={i}
                  style={{
                    padding: "28px 20px",
                    borderRadius: 22,
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    textAlign: "center",
                    opacity: ease,
                    transform: `scale(${0.9 + ease * 0.1})`,
                  }}
                >
                  <div style={{ fontSize: 40, marginBottom: 8 }}>
                    {iconMap[item.icon] ?? "\u2B50"}
                  </div>
                  <div
                    style={{
                      fontSize: 28,
                      fontWeight: 900,
                      color: "white",
                    }}
                  >
                    {item.label}
                  </div>
                </div>
              );
            })}
          </div>
        </NoOverlapStack>
      </div>
    </SafeZone>
  );
};
