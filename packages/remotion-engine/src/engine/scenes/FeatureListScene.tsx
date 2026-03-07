import React from "react";
import { useCurrentFrame } from "remotion";
import { FeatureListScene as FeatureListSceneType } from "../parser/MotionSpecTypes";
import { SafeZone } from "../layout/SafeZone";
import { NoOverlapStack } from "../layout/NoOverlapStack";

const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));

export const FeatureListRenderer: React.FC<{
  scene: FeatureListSceneType;
  green: string;
}> = ({ scene, green }) => {
  const frame = useCurrentFrame();
  const stagger = scene.motion?.staggerFrames ?? 8;
  const maxW = scene.layout?.maxWidthPx ?? 900;
  const showUnderline = scene.layout?.itemUnderline ?? false;

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
        <NoOverlapStack maxWidth={maxW} gap={16}>
          {/* Title line(s) */}
          <div style={{ textAlign: "center" }}>
            <span
              style={{
                fontSize: 68,
                fontWeight: 1000,
                color: scene.title.emphasis ? green : "white",
              }}
            >
              {scene.title.text}
            </span>
            {scene.title2 ? (
              <>
                {" "}
                <span
                  style={{
                    fontSize: 68,
                    fontWeight: 1000,
                    color: scene.title2.emphasis ? green : "white",
                  }}
                >
                  {scene.title2.text}
                </span>
              </>
            ) : null}
          </div>

          {/* Items with stagger */}
          {scene.items.map((item, i) => {
            const t = clamp((frame - i * stagger) / 10, 0, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            return (
              <div
                key={i}
                style={{
                  fontSize: 42,
                  fontWeight: 800,
                  color: "white",
                  textAlign: "center",
                  opacity: ease,
                  transform: `translateY(${(1 - ease) * 20}px)`,
                }}
              >
                {item}
                {showUnderline ? (
                  <div
                    style={{
                      margin: "6px auto 0",
                      width: Math.min(item.length * 22, 600),
                      height: 4,
                      background: green,
                      borderRadius: 999,
                      transform: `scaleX(${ease})`,
                      transformOrigin: "left",
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </NoOverlapStack>
      </div>
    </SafeZone>
  );
};
