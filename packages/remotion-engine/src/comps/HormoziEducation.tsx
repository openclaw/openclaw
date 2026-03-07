/**
 * HormoziEducation — Fast-paced educational ad (Hormozi style).
 *
 * 12 seconds @ 30fps = 360 frames
 * Profile: fast_educational
 * Motion preset: snap_edu_v1
 * 1080x1920 (9:16)
 *
 * Scene structure:
 *   Scene 1 (0–3s):   Hook headline with pop entrance
 *   Scene 2 (3–6s):   Problem statement with snap_in
 *   Scene 3 (6–9s):   Solution with UI demo + punch_in
 *   Scene 4 (9–12s):  Logo + CTA with bold_scale_up
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

// ── Safe zones from layout.json grid9x16_v1 ──
const SAFE = { top: 150, bottom: 230, left: 90, right: 90 };

// ── Caption segments ──
const CAPTION_SEGMENTS = [
  {
    start: 0,
    end: 3,
    text: "STOP EDITING. START GENERATING.",
    emphasis: ["STOP", "GENERATING"],
    style: "hormozi_box" as const,
  },
  {
    start: 3,
    end: 6,
    text: "YOU SPEND HOURS ON CLIPS THAT GET ZERO VIEWS.",
    emphasis: ["HOURS", "ZERO"],
    style: "hormozi_box" as const,
  },
  {
    start: 6,
    end: 9,
    text: "CUTMV GENERATES CLIPS IN SECONDS.",
    emphasis: ["CUTMV", "SECONDS"],
    style: "hormozi_box" as const,
  },
  {
    start: 9,
    end: 12,
    text: "TRY CUTMV — FREE CREDITS",
    emphasis: ["CUTMV", "FREE"],
    style: "hormozi_box" as const,
  },
];

// ── Scene 1: Hook ──
const SceneHook: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const enter = spring({
    fps,
    frame,
    config: { damping: 12, mass: 0.5 },
  });
  const scale = interpolate(enter, [0, 1], [0.96, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

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
          fontSize: 82,
          fontWeight: 900,
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.05,
          letterSpacing: -1,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        STOP EDITING.
        <br />
        <span style={{ color: GREEN }}>START GENERATING.</span>
      </div>
    </div>
  );
};

// ── Scene 2: Problem ──
const SceneProblem: React.FC<{ frame: number; fps: number }> = ({ frame }) => {
  const localFrame = frame;
  const slideX = interpolate(localFrame, [0, 7], [26, 0], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(localFrame, [0, 7], [0, 1], {
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
        transform: `translateX(${slideX}px)`,
      }}
    >
      <div
        style={{
          fontSize: 72,
          fontWeight: 900,
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.1,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        YOU SPEND HOURS
        <br />
        ON CLIPS THAT GET
        <br />
        <span style={{ color: GREEN }}>ZERO VIEWS.</span>
      </div>
    </div>
  );
};

// ── Scene 3: Solution + UI ──
const SceneSolution: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const enter = spring({
    fps,
    frame,
    config: { damping: 10, mass: 0.5 },
  });
  const scale = interpolate(enter, [0, 1], [0.95, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  const uiEnter = spring({
    fps,
    frame: Math.max(0, frame - 8),
    config: { damping: 12, mass: 0.6 },
  });
  const uiScale = interpolate(uiEnter, [0, 1], [0.9, 1]);
  const uiOpacity = interpolate(uiEnter, [0, 1], [0, 1]);

  return (
    <>
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
            fontSize: 68,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.1,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <span style={{ color: GREEN }}>CUTMV</span> GENERATES
          <br />
          CLIPS IN SECONDS.
        </div>
      </div>

      {/* Dashboard UI */}
      <div
        style={{
          position: "absolute",
          top: 720,
          left: SAFE.left,
          right: SAFE.right,
          height: 760,
          display: "flex",
          justifyContent: "center",
          opacity: uiOpacity,
          transform: `scale(${uiScale})`,
        }}
      >
        <Img
          src={staticFile("cutmv/dashboard_ui.jpg")}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "top center",
            borderRadius: 16,
          }}
        />
      </div>
    </>
  );
};

// ── Scene 4: Logo + CTA ──
const SceneCTA: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const enter = spring({
    fps,
    frame,
    config: { damping: 12, mass: 0.6 },
  });
  const scale = interpolate(enter, [0, 1], [0.8, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  const ctaEnter = spring({
    fps,
    frame: Math.max(0, frame - 10),
    config: { damping: 14, mass: 0.5 },
  });
  const ctaOpacity = interpolate(ctaEnter, [0, 1], [0, 1]);

  return (
    <>
      {/* Logo */}
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
        }}
      >
        <Img src={staticFile("cutmv/logo.png")} style={{ width: "60%", objectFit: "contain" }} />
      </div>

      {/* CTA */}
      <div
        style={{
          position: "absolute",
          bottom: SAFE.bottom + 40,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: ctaOpacity,
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

// ── Main Composition ──
export const HormoziEducation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Scene boundaries (seconds)
  const scenes = [
    { start: 0, end: 3, Component: SceneHook },
    { start: 3, end: 6, Component: SceneProblem },
    { start: 6, end: 9, Component: SceneSolution },
    { start: 9, end: 12, Component: SceneCTA },
  ];

  const current = scenes.find((s) => t >= s.start && t < s.end);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {current && <current.Component frame={frame - Math.floor(current.start * fps)} fps={fps} />}

      <Captions segments={CAPTION_SEGMENTS} safe={SAFE} y={1540} />
    </AbsoluteFill>
  );
};
