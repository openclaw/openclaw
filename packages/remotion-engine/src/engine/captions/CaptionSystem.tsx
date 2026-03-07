import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { CaptionConfig } from "../parser/MotionSpecTypes";
import { captionStyles } from "./captionStyles";
import { clamp, easeOutCubic } from "./captionUtils";

export const CaptionSystem: React.FC<{
  captions: CaptionConfig;
  green: string;
}> = ({ captions, green }) => {
  const frame = useCurrentFrame();
  if (!captions.enabled) return null;

  const active = captions.segments.find(
    (s) => frame >= s.from && frame < s.to,
  );
  if (!active) return null;

  const style = captionStyles[captions.style];
  const enter = clamp((frame - active.from) / 10, 0, 1);
  const exit = clamp((active.to - frame) / 10, 0, 1);
  const a = easeOutCubic(Math.min(enter, exit));

  const words = active.text.split(" ");
  const emphasis = new Set(
    (active.emphasis ?? []).map((w) => w.toUpperCase()),
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 140,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - a) * 18}px) scale(${0.98 + a * 0.02})`,
          opacity: a,
          background: "rgba(0,0,0,0.72)",
          border: `2px solid rgba(255,255,255,0.12)`,
          borderRadius: style.radius,
          padding: `${style.paddingY}px ${style.paddingX}px`,
          maxWidth: 980,
        }}
      >
        <div
          style={{
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontWeight: 900,
            color: "white",
            textAlign: "center",
            letterSpacing: 0.5,
          }}
        >
          {words.map((w, i) => {
            const clean = w.replace(/[^\w:'.-]/g, "");
            const isEmph = emphasis.has(clean.toUpperCase());
            return (
              <span key={i} style={{ color: isEmph ? green : "white" }}>
                {w}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
