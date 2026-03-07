/**
 * LogoOnlyTest — A/B test composition that renders ONLY the brand overlay
 * on a plain black background. If the logo never corrupts here, then any
 * corruption in full specs is caused by parent filters/transitions touching
 * the overlay layer.
 */
import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";

const FD_ICON_SVG = staticFile("cutmv/fd-logo-2025-white.svg");
const FD_WORDMARK_SVG = staticFile("cutmv/logo2-wordmark.svg");

export const LogoOnlyTest: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {/* Top: Icon in backing plate */}
      <div
        style={{
          position: "absolute",
          top: 26,
          left: "50%",
          transform: "translateX(-50%) translateZ(0)",
          display: "grid",
          placeItems: "center",
          isolation: "isolate",
          zIndex: 9999,
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 84,
            height: 84,
            borderRadius: 18,
            background: "rgba(0,0,0,0.35)",
            boxShadow: "0 8px 30px rgba(0,0,0,0.55)",
          }}
        />
        <Img
          src={FD_ICON_SVG}
          style={{
            width: 64,
            height: 64,
            position: "relative",
            display: "block",
            filter: "none",
            mixBlendMode: "normal",
            transform: "translateZ(0)",
            backfaceVisibility: "hidden",
          }}
        />
      </div>

      {/* Bottom: POWERED BY + wordmark */}
      <div
        style={{
          position: "absolute",
          bottom: 28,
          left: "50%",
          transform: "translateX(-50%) translateZ(0)",
          textAlign: "center",
          opacity: 0.6,
          filter: "none",
          mixBlendMode: "normal",
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 1.6,
            color: "rgba(255,255,255,0.85)",
          }}
        >
          POWERED BY
        </div>
        <Img
          src={FD_WORDMARK_SVG}
          style={{
            marginTop: 6,
            height: 14,
            width: "auto",
            display: "block",
            filter: "none",
            mixBlendMode: "normal",
            transform: "translateZ(0)",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
