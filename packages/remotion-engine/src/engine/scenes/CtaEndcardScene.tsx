import React from "react";
import { useCurrentFrame } from "remotion";
import { CtaEndcardScene as CtaEndcardSceneType } from "../parser/MotionSpecTypes";
import { SafeZone } from "../layout/SafeZone";
import { NoOverlapStack } from "../layout/NoOverlapStack";

const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));

export const CtaEndcardRenderer: React.FC<{
  scene: CtaEndcardSceneType;
  green: string;
  black: string;
}> = ({ scene, green, black }) => {
  const frame = useCurrentFrame();

  // Entrance easing
  const t = clamp(frame / 14, 0, 1);
  const ease = 1 - Math.pow(1 - t, 3);

  // CTA button pulse
  const pulse = 1 + Math.sin(frame * 0.12) * 0.015;

  // Shine sweep across CTA
  const shineX = -200 + ((frame * 8) % 1200);

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
        <NoOverlapStack maxWidth={920} gap={18}>
          {/* Headline */}
          <div
            style={{
              fontSize: 72,
              fontWeight: 1000,
              color: scene.headline.emphasis ? green : "white",
              textAlign: "center",
              opacity: ease,
              transform: `translateY(${(1 - ease) * 20}px)`,
            }}
          >
            {scene.headline.text}
          </div>

          {/* Headline 2 (if present) */}
          {scene.headline2 ? (
            <div
              style={{
                fontSize: 72,
                fontWeight: 1000,
                color: scene.headline2.emphasis ? green : "white",
                textAlign: "center",
                opacity: ease,
              }}
            >
              {scene.headline2.text}
            </div>
          ) : null}

          {/* Subhead */}
          {scene.subhead ? (
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: "rgba(255,255,255,0.6)",
                textAlign: "center",
                opacity: ease,
              }}
            >
              {scene.subhead}
            </div>
          ) : null}

          {/* CTA Button */}
          <div
            style={{
              marginTop: 8,
              padding: "18px 40px",
              borderRadius: 18,
              background: green,
              color: black,
              fontWeight: 1000,
              fontSize: 36,
              textAlign: "center",
              transform: `scale(${pulse})`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {scene.cta.text}
            {/* Shine sweep */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: shineX,
                width: 80,
                height: "100%",
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)",
                pointerEvents: "none",
              }}
            />
          </div>

          {/* Footer */}
          {scene.footer ? (
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "rgba(255,255,255,0.4)",
                textAlign: "center",
                letterSpacing: 2,
                marginTop: 6,
                opacity: ease,
              }}
            >
              {scene.footer}
            </div>
          ) : null}
        </NoOverlapStack>
      </div>
    </SafeZone>
  );
};
