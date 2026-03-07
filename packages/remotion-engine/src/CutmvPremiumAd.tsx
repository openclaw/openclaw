/**
 * CutmvPremiumAd — Premium Clean Ad (CODE-BASED UI, zero screenshots).
 *
 * MotionSpec: cutmv_ad_premium_uiblocks_v004
 * 10 seconds @ 30fps = 300 frames
 * Profile: premium_clean
 * Motion preset: ease_premium_v1
 * 1080x1920 (9:16)
 *
 * Scene structure:
 *   Scene 1 (0–2.0s):   Hook headline only
 *   Scene 2 (2.0–6.5s): UI recreation via CutmvDashboardMock + OutputList
 *   Scene 3 (6.5–8.0s): "GENERATED IN SECONDS." with underline draw
 *   Scene 4 (8.0–10s):  Logo + FD logo + CTA lockup
 *
 * UI POLICY: NO screenshot images. All UI rendered via code components.
 * Only allowed images: logos (cutmv/logo.png, cutmv/fd-logo-2025-white.png)
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  Img,
  staticFile,
  interpolate,
  spring,
} from "remotion";
import { Captions } from "./components/Captions";
import { CutmvUIFrame } from "./components/ui/CutmvUIFrame";
import { CutmvDashboardMock } from "./components/ui/CutmvDashboardMock";
import { CutmvOutputList } from "./components/ui/CutmvOutputList";

const GREEN = "#94F33F";
const SAFE = { top: 150, bottom: 230, left: 90, right: 90 };

// ── Caption segments ──
const CAPTION_SEGMENTS = [
  {
    start: 0,
    end: 2,
    text: "TURN MUSIC VIDEOS INTO VIRAL ASSETS.",
    emphasis: ["VIRAL", "ASSETS"],
    style: "premium_clean" as const,
  },
  {
    start: 2,
    end: 4.5,
    text: "CONFIGURE. GENERATE. DONE.",
    emphasis: ["GENERATE"],
    style: "premium_clean" as const,
  },
  {
    start: 4.5,
    end: 6.5,
    text: "CLIPS. GIFS. THUMBNAILS. CANVAS.",
    emphasis: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
    style: "scribble_callout" as const,
  },
  {
    start: 6.5,
    end: 8,
    text: "GENERATED IN SECONDS.",
    emphasis: ["SECONDS"],
    style: "premium_clean" as const,
  },
  {
    start: 8,
    end: 10,
    text: "TRY CUTMV",
    emphasis: ["CUTMV"],
    style: "premium_clean" as const,
  },
];

// ═══════════════════════════════════════════════
// Scene 1 — Hook Headline (0–2.0s / frames 0–60)
// fade_up: translateY 18→0, opacity 0→1, 14 frames
// ═══════════════════════════════════════════════
const SceneHook: React.FC<{ frame: number; fps: number }> = ({
  frame,
}) => {
  const fadeY = interpolate(frame, [0, 14], [18, 0], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `translateY(${fadeY}px)`,
        zIndex: 5,
      }}
    >
      <div style={{ width: "70%", textAlign: "center" }}>
        <div
          style={{
            fontSize: 72,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.1,
            letterSpacing: -0.5,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          TURN MUSIC VIDEOS
          <br />
          INTO <span style={{ color: GREEN }}>VIRAL</span> ASSETS
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// Scene 2 — UI Recreation (2.0–6.5s / frames 60–195)
// Code-based: CutmvUIFrame + CutmvDashboardMock + CutmvOutputList
// scale_in: 0.98→1.0, 16 frames
// ═══════════════════════════════════════════════
const SceneUI: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Header text fade_up
  const headerY = interpolate(frame, [0, 14], [18, 0], {
    extrapolateRight: "clamp",
  });
  const headerOpacity = interpolate(frame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Dashboard mock scale_in (delayed 6 frames)
  const dashFrame = Math.max(0, frame - 6);
  const dashScale = interpolate(dashFrame, [0, 16], [0.98, 1], {
    extrapolateRight: "clamp",
  });
  const dashOpacity = interpolate(dashFrame, [0, 16], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Output list appears after dashboard (delayed 30 frames)
  const outputFrame = Math.max(0, frame - 30);
  const outputOpacity = interpolate(outputFrame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });
  const outputY = interpolate(outputFrame, [0, 14], [18, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <>
      {/* "CONFIGURE. GENERATE. DONE." header */}
      <div
        style={{
          position: "absolute",
          top: 190,
          left: SAFE.left,
          right: SAFE.right,
          opacity: headerOpacity,
          transform: `translateY(${headerY}px)`,
          zIndex: 6,
        }}
      >
        <div
          style={{
            fontSize: 42,
            fontWeight: 800,
            color: "#fff",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
          }}
        >
          CONFIGURE. <span style={{ color: GREEN }}>GENERATE.</span> DONE.
        </div>
      </div>

      {/* Dashboard Mock — code-based, no screenshots */}
      <div
        style={{
          position: "absolute",
          top: 340,
          left: SAFE.left,
          right: SAFE.right,
          height: 520,
          display: "flex",
          justifyContent: "center",
          opacity: dashOpacity,
          transform: `scale(${dashScale})`,
          zIndex: 5,
        }}
      >
        <CutmvUIFrame variant="browser" width={820} height={520}>
          <CutmvDashboardMock variant="output_config" />
        </CutmvUIFrame>
      </div>

      {/* Output List — code-based, staggered rows */}
      <div
        style={{
          position: "absolute",
          top: 920,
          left: SAFE.left + 40,
          right: SAFE.right + 40,
          opacity: outputOpacity,
          transform: `translateY(${outputY}px)`,
          zIndex: 5,
        }}
      >
        <CutmvOutputList highlight="CLIPS" staggerFrame={outputFrame} staggerDelay={4} />
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════
// Scene 3 — Statement (6.5–8.0s / frames 195–240)
// "GENERATED IN SECONDS." + green underline draw left→right
// slow_scale: 1.0→1.03 over 75 frames
// ═══════════════════════════════════════════════
const SceneStatement: React.FC<{ frame: number; fps: number }> = ({
  frame,
}) => {
  const opacity = interpolate(frame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });
  const scale = interpolate(frame, [0, 75], [1.0, 1.03], {
    extrapolateRight: "clamp",
  });

  // Green underline draw
  const underlineW = interpolate(frame, [8, 22], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        opacity,
        transform: `scale(${scale})`,
        zIndex: 5,
      }}
    >
      <div style={{ position: "relative", display: "inline-block" }}>
        <div
          style={{
            fontSize: 78,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.1,
            letterSpacing: -1,
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
          }}
        >
          GENERATED IN
          <br />
          <span style={{ color: GREEN }}>SECONDS.</span>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: -6,
            left: 0,
            width: `${underlineW}%`,
            height: 6,
            background: GREEN,
            borderRadius: 3,
          }}
        />
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// Scene 4 — Logo + CTA Lockup (8.0–10s / frames 240–300)
// CUTMV logo: 60% width, logo_reveal (scale 0.8→1.0, 18 frames)
// FD logo: 22% width, delayed
// CTA: "TRY CUTMV" in green
// ═══════════════════════════════════════════════
const SceneCTA: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Logo reveal
  const logoEnter = spring({
    fps,
    frame,
    config: { damping: 14, mass: 0.7 },
  });
  const logoScale = interpolate(logoEnter, [0, 1], [0.8, 1]);
  const logoOpacity = interpolate(logoEnter, [0, 1], [0, 1]);

  // FD logo (delayed 8 frames)
  const fdFrame = Math.max(0, frame - 8);
  const fdOpacity = interpolate(fdFrame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  // CTA text (delayed 14 frames)
  const ctaFrame = Math.max(0, frame - 14);
  const ctaOpacity = interpolate(ctaFrame, [0, 10], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <>
      {/* CUTMV Logo — centered, 60% width */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 280,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
          zIndex: 10,
        }}
      >
        <Img
          src={staticFile("cutmv/logo.png")}
          style={{ width: "60%", objectFit: "contain" }}
        />
      </div>

      {/* FD Logo — smaller beneath */}
      <div
        style={{
          position: "absolute",
          bottom: SAFE.bottom + 130,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          opacity: fdOpacity,
          zIndex: 9,
        }}
      >
        <Img
          src={staticFile("cutmv/fd-logo-2025-white.png")}
          style={{ width: "22%", objectFit: "contain" }}
        />
      </div>

      {/* CTA Text */}
      <div
        style={{
          position: "absolute",
          bottom: SAFE.bottom + 40,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: ctaOpacity,
          zIndex: 9,
        }}
      >
        <span
          style={{
            fontSize: 48,
            fontWeight: 900,
            color: GREEN,
            textTransform: "uppercase",
            letterSpacing: 2,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          TRY CUTMV
        </span>
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════
// Main Composition
// ═══════════════════════════════════════════════
export const CutmvPremiumAd: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const scenes = [
    { start: 0, end: 2, Component: SceneHook },
    { start: 2, end: 6.5, Component: SceneUI },
    { start: 6.5, end: 8, Component: SceneStatement },
    { start: 8, end: 10, Component: SceneCTA },
  ];

  const current = scenes.find((s) => t >= s.start && t < s.end);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {current && (
        <current.Component
          frame={frame - Math.floor(current.start * fps)}
          fps={fps}
        />
      )}

      <Captions
        segments={CAPTION_SEGMENTS}
        safe={SAFE}
        y={1540}
      />
    </AbsoluteFill>
  );
};
