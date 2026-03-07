/**
 * MixedMediaScribble — Mixed media ad with scribble overlays.
 *
 * 14 seconds @ 30fps = 420 frames
 * Profile: native_social
 * Motion preset: snap_social_v1
 * 1080x1920 (9:16)
 *
 * Scene structure:
 *   Scene 1 (0–3.5s):   Scroll-stop hook with whip_zoom
 *   Scene 2 (3.5–7s):   Demo frames showcase with slide_in_left
 *   Scene 3 (7–10.5s):  Feature callouts with scribble_callout captions
 *   Scene 4 (10.5–14s): Logo + CTA with hard_snap
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
import { Captions } from "../components/Captions";

const GREEN = "#94F33F";
const SAFE = { top: 150, bottom: 230, left: 90, right: 90 };

const CAPTION_SEGMENTS = [
  {
    start: 0,
    end: 3.5,
    text: "YOUR MUSIC VIDEO. OUR AI.",
    emphasis: ["AI"],
    style: "scribble_callout" as const,
  },
  {
    start: 3.5,
    end: 7,
    text: "CLIPS. GIFS. THUMBNAILS. CANVAS.",
    emphasis: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
    style: "scribble_callout" as const,
  },
  {
    start: 7,
    end: 10.5,
    text: "ALL GENERATED FROM ONE UPLOAD.",
    emphasis: ["ONE"],
    style: "scribble_callout" as const,
  },
  {
    start: 10.5,
    end: 14,
    text: "TRY CUTMV NOW",
    emphasis: ["CUTMV"],
    style: "scribble_callout" as const,
  },
];

// ── Scene 1: Scroll-Stop Hook ──
const SceneHook: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // whip_zoom: scale from 1.3 → 1.0
  const scale = interpolate(frame, [0, 8], [1.3, 1], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [0, 8], [0.5, 1], {
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
      }}
    >
      <div
        style={{
          fontSize: 84,
          fontWeight: 900,
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.05,
          letterSpacing: -1,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        YOUR MUSIC VIDEO.
        <br />
        OUR <span style={{ color: GREEN }}>AI.</span>
      </div>
    </div>
  );
};

// ── Scene 2: Demo Frames Showcase ──
const SceneDemo: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const frames = [
    "cutmv/demo_frame_001.png",
    "cutmv/demo_frame_002.png",
    "cutmv/demo_frame_003.png",
  ];

  return (
    <>
      {/* Headline */}
      <div
        style={{
          position: "absolute",
          top: 190,
          left: SAFE.left,
          right: SAFE.right,
        }}
      >
        <div
          style={{
            fontSize: 58,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.1,
            fontFamily: "system-ui, sans-serif",
            opacity: interpolate(frame, [0, 9], [0, 1], {
              extrapolateRight: "clamp",
            }),
            transform: `translateX(${interpolate(frame, [0, 9], [-60, 0], { extrapolateRight: "clamp" })}px)`,
          }}
        >
          GENERATED <span style={{ color: GREEN }}>CONTENT</span>
        </div>
      </div>

      {/* Demo frame strip */}
      <div
        style={{
          position: "absolute",
          top: 720,
          left: SAFE.left,
          right: SAFE.right,
          height: 760,
          display: "flex",
          gap: 12,
          justifyContent: "center",
        }}
      >
        {frames.map((src, i) => {
          const staggerFrame = Math.max(0, frame - i * 5);
          const slideX = interpolate(staggerFrame, [0, 9], [-60, 0], {
            extrapolateRight: "clamp",
          });
          const itemOpacity = interpolate(staggerFrame, [0, 9], [0, 1], {
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={src}
              style={{
                flex: 1,
                opacity: itemOpacity,
                transform: `translateX(${slideX}px)`,
              }}
            >
              <Img
                src={staticFile(src)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  borderRadius: 12,
                }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
};

// ── Scene 3: Feature Callouts ──
const SceneFeatures: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const features = [
    "CLIPS FROM ANY VIDEO",
    "GIF EXPORTS IN 1 TAP",
    "AI THUMBNAILS",
    "SOCIAL CANVAS SIZES",
  ];

  return (
    <div
      style={{
        position: "absolute",
        top: 190,
        left: SAFE.left,
        right: SAFE.right,
        bottom: SAFE.bottom,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 48,
      }}
    >
      {features.map((text, i) => {
        const staggerFrame = Math.max(0, frame - i * 6);
        const snapScale = interpolate(staggerFrame, [0, 6], [0.9, 1], {
          extrapolateRight: "clamp",
        });
        const itemOpacity = interpolate(staggerFrame, [0, 6], [0, 1], {
          extrapolateRight: "clamp",
        });

        // Green underline draw
        const underlineW = interpolate(
          staggerFrame,
          [4, 14],
          [0, 100],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );

        return (
          <div
            key={text}
            style={{
              opacity: itemOpacity,
              transform: `scale(${snapScale})`,
              position: "relative",
              display: "inline-block",
            }}
          >
            <div
              style={{
                fontSize: 56,
                fontWeight: 900,
                color: "#fff",
                textTransform: "uppercase",
                fontFamily: "system-ui, sans-serif",
              }}
            >
              {text}
            </div>
            <div
              style={{
                position: "absolute",
                bottom: -4,
                left: 0,
                width: `${underlineW}%`,
                height: 5,
                background: GREEN,
                borderRadius: 3,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

// ── Scene 4: Logo + CTA ──
const SceneCTA: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // hard_snap entrance
  const scale = interpolate(frame, [0, 9], [0.85, 1], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [0, 9], [0, 1], {
    extrapolateRight: "clamp",
  });

  const ctaEnter = spring({
    fps,
    frame: Math.max(0, frame - 12),
    config: { damping: 14, mass: 0.5 },
  });
  const ctaOpacity = interpolate(ctaEnter, [0, 1], [0, 1]);

  return (
    <>
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
          zIndex: 10,
        }}
      >
        <Img
          src={staticFile("cutmv/logo.png")}
          style={{ width: "60%", objectFit: "contain" }}
        />
      </div>

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
          TRY CUTMV NOW
        </span>
      </div>
    </>
  );
};

// ── Main Composition ──
export const MixedMediaScribble: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const scenes = [
    { start: 0, end: 3.5, Component: SceneHook },
    { start: 3.5, end: 7, Component: SceneDemo },
    { start: 7, end: 10.5, Component: SceneFeatures },
    { start: 10.5, end: 14, Component: SceneCTA },
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
