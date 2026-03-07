import React from "react";
import { useCurrentFrame } from "remotion";
import { StepSceneSpec } from "../parser/MotionSpecTypes";
import { SafeZone } from "../layout/SafeZone";
import { NoOverlapStack } from "../layout/NoOverlapStack";

const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));

export const StepSceneRenderer: React.FC<{
  scene: StepSceneSpec;
  green: string;
}> = ({ scene, green }) => {
  const frame = useCurrentFrame();

  // Step label pop
  const labelT = clamp(frame / 10, 0, 1);
  const labelEase = 1 - Math.pow(1 - labelT, 3);

  // Body text stagger
  const bodyT = clamp((frame - 8) / 12, 0, 1);
  const bodyEase = 1 - Math.pow(1 - bodyT, 3);

  // Support text
  const supportT = clamp((frame - 18) / 12, 0, 1);
  const supportEase = 1 - Math.pow(1 - supportT, 3);

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
        <NoOverlapStack maxWidth={920} gap={20}>
          {/* Step badge */}
          <div
            style={{
              display: "inline-block",
              padding: "10px 22px",
              borderRadius: 999,
              background: green,
              color: "#0B0B0F",
              fontWeight: 1000,
              fontSize: 28,
              opacity: labelEase,
              transform: `scale(${0.8 + labelEase * 0.2})`,
            }}
          >
            {scene.step.label}
          </div>

          {/* Step text */}
          <div
            style={{
              fontSize: 64,
              fontWeight: 1000,
              color: "white",
              textAlign: "center",
              opacity: bodyEase,
              transform: `translateY(${(1 - bodyEase) * 24}px)`,
            }}
          >
            {scene.step.text}
          </div>

          {/* Support line */}
          {scene.support ? (
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: "rgba(255,255,255,0.6)",
                textAlign: "center",
                opacity: supportEase,
                transform: `translateY(${(1 - supportEase) * 14}px)`,
              }}
            >
              {scene.support}
            </div>
          ) : null}
        </NoOverlapStack>
      </div>
    </SafeZone>
  );
};
