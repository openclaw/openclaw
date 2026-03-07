/**
 * HiggsfieldSaasProd — Fast Educational SaaS Ad (engine-safe).
 *
 * MotionSpec: cutmv_fast_edu_saas_v001
 * 14 seconds @ 30fps = 420 frames
 * Profile: fast_educational
 * Motion preset: snap_edu_v1
 * 1080x1920 (9:16)
 *
 * Scene structure:
 *   Scene 1 (0–2.5s):    HARD HOOK — "YOUR CONTENT IS COSTING YOU FANS."
 *   Scene 2 (2.5–6s):    PROBLEM + PAIN — text dominant, no UI
 *   Scene 3 (6–10s):     PRODUCT REVEAL — ONE UI screen + benefit line
 *   Scene 4 (10–13s):    DEMO PROOF — demo frame burst + "GENERATED IN SECONDS."
 *   Scene 5 (13–14s):    CTA LOCKUP — dual logo + CTA, settles in 0.8s
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  Img,
  staticFile,
  interpolate,
} from "remotion";
import { Captions } from "../components/Captions";

const GREEN = "#94F33F";
const SAFE = { top: 150, bottom: 230, left: 90, right: 90 };

// ── Caption segments (6 total, engine-required) ──
const CAPTION_SEGMENTS = [
  {
    start: 0,
    end: 2.5,
    text: "YOUR CONTENT IS COSTING YOU FANS.",
    emphasis: ["COSTING", "FANS"],
    style: "hormozi_box" as const,
  },
  {
    start: 2.5,
    end: 4.5,
    text: "YOU EDIT FOR HOURS.",
    emphasis: ["HOURS"],
    style: "scribble_callout" as const,
  },
  {
    start: 4.5,
    end: 6,
    text: "NOBODY WATCHES.",
    emphasis: ["NOBODY"],
    style: "scribble_callout" as const,
  },
  {
    start: 6,
    end: 10,
    text: "ONE UPLOAD. EVERYTHING GENERATED.",
    emphasis: ["ONE", "EVERYTHING"],
    style: "hormozi_box" as const,
  },
  {
    start: 10,
    end: 13,
    text: "GENERATED IN SECONDS.",
    emphasis: ["SECONDS"],
    style: "scribble_callout" as const,
  },
  {
    start: 13,
    end: 14,
    text: "TRY CUTMV FREE",
    emphasis: ["CUTMV", "FREE"],
    style: "hormozi_box" as const,
  },
];

// ═══════════════════════════════════════════════
// Scene 1 — HARD HOOK (0–2.5s / frames 0–75)
// Animation: pop (scale 0.96→1.0, 8 frames)
// ═══════════════════════════════════════════════
const SceneHook: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const scale = interpolate(frame, [0, 8], [0.96, 1], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: 190,
        left: SAFE.left,
        right: SAFE.right,
        opacity,
        transform: `scale(${scale})`,
        zIndex: 8,
      }}
    >
      <div
        style={{
          fontSize: 82,
          fontWeight: 900,
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.05,
          letterSpacing: -1,
          fontFamily: "system-ui, sans-serif",
          maxWidth: "84%",
        }}
      >
        YOUR CONTENT
        <br />
        IS <span style={{ color: GREEN }}>COSTING</span>
        <br />
        YOU <span style={{ color: GREEN }}>FANS.</span>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// Scene 2 — PROBLEM + PAIN (2.5–6s / frames 75–180)
// Animation: snap_in (translateX 26→0, 7 frames)
// Text dominant. No UI.
// ═══════════════════════════════════════════════
const SceneProblem: React.FC<{ frame: number; fps: number }> = ({
  frame,
}) => {
  // Line 1: snap_in
  const slideX1 = interpolate(frame, [0, 7], [26, 0], {
    extrapolateRight: "clamp",
  });
  const opacity1 = interpolate(frame, [0, 7], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Line 2: delayed snap_in
  const slideX2 = interpolate(Math.max(0, frame - 12), [0, 7], [26, 0], {
    extrapolateRight: "clamp",
  });
  const opacity2 = interpolate(Math.max(0, frame - 12), [0, 7], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Sub line: delayed more
  const subOpacity = interpolate(Math.max(0, frame - 30), [0, 7], [0, 1], {
    extrapolateRight: "clamp",
  });
  const subSlideX = interpolate(Math.max(0, frame - 30), [0, 7], [26, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: 190,
        left: SAFE.left,
        right: SAFE.right,
        zIndex: 8,
      }}
    >
      <div
        style={{
          fontSize: 74,
          fontWeight: 900,
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.08,
          fontFamily: "system-ui, sans-serif",
          opacity: opacity1,
          transform: `translateX(${slideX1}px)`,
        }}
      >
        YOU EDIT FOR <span style={{ color: GREEN }}>HOURS.</span>
      </div>
      <div
        style={{
          fontSize: 74,
          fontWeight: 900,
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.08,
          fontFamily: "system-ui, sans-serif",
          marginTop: 20,
          opacity: opacity2,
          transform: `translateX(${slideX2}px)`,
        }}
      >
        <span style={{ color: GREEN }}>NOBODY</span> WATCHES.
      </div>

      {/* Sub-line */}
      <div
        style={{
          marginTop: 60,
          fontSize: 38,
          fontWeight: 700,
          color: "rgba(255,255,255,0.65)",
          textTransform: "uppercase",
          fontFamily: "system-ui, sans-serif",
          opacity: subOpacity,
          transform: `translateX(${subSlideX}px)`,
        }}
      >
        EVERY ARTIST LOSES 80% OF REACH
        <br />
        FROM BAD CONTENT.
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// Scene 3 — PRODUCT REVEAL (6–10s / frames 180–300)
// Animation: punch_in (scale 0.95→1.0, 12 frames)
// ONE UI screen + 1 benefit line overlay
// ═══════════════════════════════════════════════
const SceneProduct: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Headline punch_in
  const headScale = interpolate(frame, [0, 12], [0.95, 1], {
    extrapolateRight: "clamp",
  });
  const headOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  // UI punch_in (delayed 8 frames)
  const uiFrame = Math.max(0, frame - 8);
  const uiScale = interpolate(uiFrame, [0, 12], [0.95, 1], {
    extrapolateRight: "clamp",
  });
  const uiOpacity = interpolate(uiFrame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Benefit line (delayed 20 frames)
  const benefitFrame = Math.max(0, frame - 20);
  const benefitOpacity = interpolate(benefitFrame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <>
      {/* Headline */}
      <div
        style={{
          position: "absolute",
          top: 190,
          left: SAFE.left,
          right: SAFE.right,
          opacity: headOpacity,
          transform: `scale(${headScale})`,
          zIndex: 7,
        }}
      >
        <div
          style={{
            fontSize: 68,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.08,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <span style={{ color: GREEN }}>ONE</span> UPLOAD.
          <br />
          <span style={{ color: GREEN }}>EVERYTHING</span> GENERATED.
        </div>
      </div>

      {/* Dashboard UI — ONE hero moment */}
      <div
        style={{
          position: "absolute",
          top: 720,
          left: SAFE.left,
          right: SAFE.right,
          height: 660,
          display: "flex",
          justifyContent: "center",
          opacity: uiOpacity,
          transform: `scale(${uiScale})`,
          zIndex: 5,
        }}
      >
        <Img
          src={staticFile("cutmv/dashboard_ui.jpg")}
          style={{
            width: "85%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "top center",
            borderRadius: 16,
          }}
        />
      </div>

      {/* Benefit line */}
      <div
        style={{
          position: "absolute",
          top: 1420,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: benefitOpacity,
          zIndex: 6,
        }}
      >
        <span
          style={{
            fontSize: 34,
            fontWeight: 800,
            color: GREEN,
            letterSpacing: 4,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          CLIPS · GIFS · THUMBNAILS · CANVAS
        </span>
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════
// Scene 4 — DEMO PROOF (10–13s / frames 300–390)
// Animation: rapid_stagger (stagger 3 frames, scale 1.1→1.0)
// Demo frame burst + overlay text
// ═══════════════════════════════════════════════
const SceneDemo: React.FC<{ frame: number; fps: number }> = ({
  frame,
}) => {
  const demoFrames = [
    "cutmv/demo_frame_001.png",
    "cutmv/demo_frame_002.png",
    "cutmv/demo_frame_003.png",
  ];

  // Overlay text "GENERATED IN SECONDS."
  const textFrame = Math.max(0, frame - 15);
  const textScale = interpolate(textFrame, [0, 8], [0.96, 1], {
    extrapolateRight: "clamp",
  });
  const textOpacity = interpolate(textFrame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Green underline draw
  const underlineW = interpolate(Math.max(0, frame - 22), [0, 12], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <>
      {/* Demo frame strip — rapid stagger */}
      <div
        style={{
          position: "absolute",
          top: 420,
          left: SAFE.left,
          right: SAFE.right,
          height: 780,
          display: "flex",
          gap: 14,
          zIndex: 4,
        }}
      >
        {demoFrames.map((src, i) => {
          const staggerFrame = Math.max(0, frame - i * 3);
          const itemScale = interpolate(staggerFrame, [0, 5], [1.1, 1], {
            extrapolateRight: "clamp",
          });
          const itemOpacity = interpolate(staggerFrame, [0, 5], [0, 1], {
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={src}
              style={{
                flex: 1,
                opacity: itemOpacity,
                transform: `scale(${itemScale})`,
                overflow: "hidden",
                borderRadius: 12,
              }}
            >
              <Img
                src={staticFile(src)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Overlay: GENERATED IN SECONDS. */}
      <div
        style={{
          position: "absolute",
          top: 190,
          left: SAFE.left,
          right: SAFE.right,
          opacity: textOpacity,
          transform: `scale(${textScale})`,
          zIndex: 6,
        }}
      >
        <div style={{ position: "relative", display: "inline-block" }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 900,
              color: "#fff",
              textTransform: "uppercase",
              lineHeight: 1.08,
              fontFamily: "system-ui, sans-serif",
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
    </>
  );
};

// ═══════════════════════════════════════════════
// Scene 5 — CTA LOCKUP (13–14s / frames 390–420)
// Animation: bold_scale_up (scale 0.8→1.0, 12 frames)
// Logo centered 60%, FD logo smaller beneath, CTA, settle by 0.8s
// ═══════════════════════════════════════════════
const SceneCTA: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Logo bold_scale_up — settles within ~12 frames (0.4s)
  const logoScale = interpolate(frame, [0, 12], [0.8, 1], {
    extrapolateRight: "clamp",
  });
  const logoOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  // FD logo (delayed 6 frames)
  const fdFrame = Math.max(0, frame - 6);
  const fdOpacity = interpolate(fdFrame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  // CTA text (delayed 10 frames)
  const ctaFrame = Math.max(0, frame - 10);
  const ctaOpacity = interpolate(ctaFrame, [0, 6], [0, 1], {
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
          bottom: 200,
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
          bottom: SAFE.bottom + 140,
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
            letterSpacing: 3,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          TRY CUTMV FREE
        </span>
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════
// Main Composition
// ═══════════════════════════════════════════════
export const HiggsfieldSaasProd: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const scenes = [
    { start: 0, end: 2.5, Component: SceneHook },
    { start: 2.5, end: 6, Component: SceneProblem },
    { start: 6, end: 10, Component: SceneProduct },
    { start: 10, end: 13, Component: SceneDemo },
    { start: 13, end: 14, Component: SceneCTA },
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
