/**
 * CutmvPremiumAdV5 — Premium SaaS Ad with reconstructed UI + ambient atmosphere.
 *
 * MotionSpec: cutmv_premium_v5_reconstructed
 * 10 seconds @ 30fps = 300 frames
 * 1080x1920 (9:16)
 *
 * Zero screenshots. All UI built from code components.
 * Reference frames used for layout/structure only (NOT embedded).
 *
 * Scene structure:
 *   Scene 1 (0–2s):     Hook — "ONE UPLOAD. EVERYTHING GENERATED."
 *   Scene 2 (2–6s):     UI Recreation — ConfigureOutputCard + floating GenerateCard
 *   Scene 3 (6–8s):     Card Stack — 3D layered cards with depth + glow
 *   Scene 4 (8–10s):    CTA — Green gradient flood + logo + "MORE CONTENT. LESS WORK."
 *
 * Visual system:
 *   - Deep black → charcoal gradient background
 *   - Animated film grain texture
 *   - Green radial glow (breathing)
 *   - Floating particles
 *   - Vignette edges
 *   - 3D card tilt with parallax depth
 *   - Toggle glow pulse
 *   - Green underline reveals
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
import { AmbientLayer } from "../components/ui/AmbientLayer";
import { ConfigureOutputCard } from "../components/ui/ConfigureOutputCard";
import { GenerateCard } from "../components/ui/GenerateCard";

const GREEN = "#94F33F";
const SAFE = { top: 150, bottom: 230, left: 90, right: 90 };

// ── Caption segments ──
const CAPTION_SEGMENTS = [
  {
    start: 0,
    end: 2,
    text: "ONE UPLOAD. EVERYTHING GENERATED.",
    emphasis: ["ONE", "EVERYTHING"],
    style: "premium_clean" as const,
  },
  {
    start: 2,
    end: 4,
    text: "CONFIGURE YOUR OUTPUT.",
    emphasis: ["CONFIGURE"],
    style: "premium_clean" as const,
  },
  {
    start: 4,
    end: 6,
    text: "SHORT-FORM CLIPS, GIFS, THUMBNAILS.",
    emphasis: ["CLIPS", "GIFS", "THUMBNAILS"],
    style: "scribble_callout" as const,
  },
  {
    start: 6,
    end: 8,
    text: "GENERATED IN SECONDS.",
    emphasis: ["SECONDS"],
    style: "scribble_callout" as const,
  },
  {
    start: 8,
    end: 10,
    text: "MORE CONTENT. LESS WORK.",
    emphasis: ["MORE", "LESS"],
    style: "premium_clean" as const,
  },
];

// ═══════════════════════════════════════════════
// Scene 1 — HOOK (0–2s / frames 0–60)
// Camera push-in: slow scale 1.0→1.04
// Green words animate with underline reveal
// ═══════════════════════════════════════════════
const SceneHook: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Slow camera push-in
  const pushIn = interpolate(frame, [0, 60], [1.0, 1.04], {
    extrapolateRight: "clamp",
  });

  // Text fade_up
  const line1Y = interpolate(frame, [0, 14], [24, 0], {
    extrapolateRight: "clamp",
  });
  const line1Opacity = interpolate(frame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });

  const line2Y = interpolate(Math.max(0, frame - 8), [0, 14], [24, 0], {
    extrapolateRight: "clamp",
  });
  const line2Opacity = interpolate(Math.max(0, frame - 8), [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Green underline reveal on "EVERYTHING"
  const underlineW = interpolate(frame, [18, 36], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        transform: `scale(${pushIn})`,
        zIndex: 5,
      }}
    >
      <div style={{ textAlign: "center", width: "80%" }}>
        <div
          style={{
            fontSize: 72,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.08,
            letterSpacing: -1,
            fontFamily: "system-ui, sans-serif",
            opacity: line1Opacity,
            transform: `translateY(${line1Y}px)`,
          }}
        >
          <span style={{ color: GREEN }}>ONE</span> UPLOAD.
        </div>
        <div
          style={{
            fontSize: 72,
            fontWeight: 900,
            color: "#fff",
            textTransform: "uppercase",
            lineHeight: 1.08,
            letterSpacing: -1,
            fontFamily: "system-ui, sans-serif",
            marginTop: 8,
            opacity: line2Opacity,
            transform: `translateY(${line2Y}px)`,
            position: "relative",
            display: "inline-block",
          }}
        >
          <span style={{ color: GREEN }}>EVERYTHING</span> GENERATED.
          <div
            style={{
              position: "absolute",
              bottom: -6,
              left: 0,
              width: `${underlineW}%`,
              height: 5,
              background: GREEN,
              borderRadius: 3,
            }}
          />
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// Scene 2 — UI RECREATION (2–6s / frames 60–180)
// ConfigureOutputCard with parallax float
// Floating GenerateCard (tilted, glow pulse)
// Ref: frames 1677, 1733
// ═══════════════════════════════════════════════
const SceneUIRecreation: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // ── ConfigureOutputCard entrance — slide up + scale ──
  const cardEnter = spring({
    fps,
    frame,
    config: { damping: 16, mass: 0.8 },
  });
  const cardY = interpolate(cardEnter, [0, 1], [40, 0]);
  const cardOpacity = interpolate(cardEnter, [0, 1], [0, 1]);
  const cardScale = interpolate(cardEnter, [0, 1], [0.97, 1]);

  // Micro-float on the card (parallax depth)
  const floatY = Math.sin(frame * 0.06) * 3;
  const floatX = Math.cos(frame * 0.04) * 2;

  // ── GenerateCard (tilted floating card) — delayed entrance ──
  const gcFrame = Math.max(0, frame - 20);
  const gcEnter = spring({
    fps,
    frame: gcFrame,
    config: { damping: 14, mass: 0.7 },
  });
  const gcScale = interpolate(gcEnter, [0, 1], [0.9, 1]);
  const gcOpacity = interpolate(gcEnter, [0, 1], [0, 1]);

  // Toggle glow pulse
  const glowPulse = interpolate(
    Math.sin(frame * 0.08),
    [-1, 1],
    [0.3, 1],
  );

  // ── Headline fade ──
  const headOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });
  const headY = interpolate(frame, [0, 12], [16, 0], {
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
          transform: `translateY(${headY}px)`,
          zIndex: 8,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontSize: 38,
            fontWeight: 800,
            color: "#fff",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <span style={{ color: GREEN }}>CONFIGURE</span> YOUR OUTPUT
        </span>
      </div>

      {/* ConfigureOutputCard — main panel, centered */}
      <div
        style={{
          position: "absolute",
          top: 330,
          left: SAFE.left + 30,
          right: SAFE.right + 30,
          opacity: cardOpacity,
          transform: `translateY(${cardY + floatY}px) translateX(${floatX}px) scale(${cardScale})`,
          zIndex: 6,
        }}
      >
        <ConfigureOutputCard showTimestamp={frame > 30} />
      </div>

      {/* Floating GenerateCard — tilted, offset right */}
      <div
        style={{
          position: "absolute",
          top: 960,
          left: SAFE.left + 60,
          right: SAFE.right + 20,
          opacity: gcOpacity,
          transform: `scale(${gcScale}) rotate(-3deg) translateY(${floatY * -1.5}px)`,
          zIndex: 7,
        }}
      >
        <GenerateCard
          title="Generate Professional GIFs"
          subtitle="Pack of 5 × 6-second GIFs"
          credits="180 credits"
          note="Professional quality with no watermarks"
          toggleOn={frame > 40}
          tiltDeg={0}
          glowIntensity={frame > 40 ? glowPulse : 0}
        />
      </div>

      {/* "SHORT-FORM CLIPS, GIFS, THUMBNAILS" text — bottom */}
      {frame > 60 && (
        <div
          style={{
            position: "absolute",
            bottom: SAFE.bottom + 80,
            left: SAFE.left,
            right: SAFE.right,
            textAlign: "center",
            opacity: interpolate(Math.max(0, frame - 60), [0, 14], [0, 1], {
              extrapolateRight: "clamp",
            }),
            zIndex: 8,
          }}
        >
          <div
            style={{
              fontSize: 46,
              fontWeight: 900,
              color: GREEN,
              textTransform: "uppercase",
              lineHeight: 1.15,
              fontFamily: "system-ui, sans-serif",
            }}
          >
            SHORT-FORM CLIPS,
            <br />
            GIFS, THUMBNAILS
          </div>
        </div>
      )}
    </>
  );
};

// ═══════════════════════════════════════════════
// Scene 3 — CARD STACK (6–8s / frames 180–240)
// 3D layered card stack with depth + rim light + green glow
// Ref: frames 1752, 1823
// ═══════════════════════════════════════════════
const SceneCardStack: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  const cards = [
    {
      title: "Generate Professional\nSpotify Canvas",
      subtitle: "Pack of 2 × 8-second Canvas",
      credits: "450 credits",
      note: "Professional quality exports ready for commercial use",
      on: true,
    },
    {
      title: "Generate Professional\nThumbnails",
      subtitle: "Pack of 5 thumbnails",
      credits: "180 credits",
      note: "Professional quality with no watermarks",
      on: true,
    },
    {
      title: "Generate Professional\nGIFs",
      subtitle: "Pack of 5 × 6-second GIFs",
      credits: "180 credits",
      note: "Professional quality with no watermarks",
      on: false,
    },
  ];

  // "GENERATED IN SECONDS" overlay text
  const textFrame = Math.max(0, frame - 20);
  const textOpacity = interpolate(textFrame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textScale = interpolate(textFrame, [0, 14], [0.98, 1], {
    extrapolateRight: "clamp",
  });

  // Green underline on "SECONDS"
  const underlineW = interpolate(Math.max(0, frame - 30), [0, 14], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <>
      {/* Card stack */}
      <div
        style={{
          position: "absolute",
          top: 320,
          left: SAFE.left + 20,
          right: SAFE.right + 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
          zIndex: 5,
        }}
      >
        {cards.map((card, i) => {
          const staggerFrame = Math.max(0, frame - i * 5);
          const enter = spring({
            fps,
            frame: staggerFrame,
            config: { damping: 14, mass: 0.6 },
          });

          const yOffset = i * -20; // Stack overlap
          const scale = interpolate(enter, [0, 1], [0.92, 1 - i * 0.03]);
          const opacity = interpolate(enter, [0, 1], [0, 1]);
          const rotateZ = (i - 1) * 2; // Slight fan

          // Micro-float
          const floatY = Math.sin(frame * 0.05 + i * 1.2) * 2;

          return (
            <div
              key={i}
              style={{
                width: "88%",
                marginTop: i === 0 ? 0 : -30,
                opacity,
                transform: `scale(${scale}) rotate(${rotateZ}deg) translateY(${yOffset + floatY}px)`,
                zIndex: 5 - i,
                position: "relative",
              }}
            >
              <GenerateCard
                title={card.title}
                subtitle={card.subtitle}
                credits={card.credits}
                note={card.note}
                toggleOn={card.on}
                glowIntensity={card.on ? 0.6 : 0}
              />
            </div>
          );
        })}
      </div>

      {/* "GENERATED IN SECONDS." overlay */}
      <div
        style={{
          position: "absolute",
          bottom: SAFE.bottom + 100,
          left: SAFE.left,
          right: SAFE.right,
          textAlign: "center",
          opacity: textOpacity,
          transform: `scale(${textScale})`,
          zIndex: 8,
        }}
      >
        <div style={{ position: "relative", display: "inline-block" }}>
          <div
            style={{
              fontSize: 58,
              fontWeight: 900,
              color: "#fff",
              textTransform: "uppercase",
              lineHeight: 1.1,
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
              height: 5,
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
// Scene 4 — CTA (8–10s / frames 240–300)
// Green gradient flood background
// Logo centered + "MORE CONTENT. LESS WORK."
// Ref: frames 1854, 1863
// ═══════════════════════════════════════════════
const SceneCTA: React.FC<{ frame: number; fps: number }> = ({
  frame,
  fps,
}) => {
  // Green gradient flood entrance
  const floodOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Logo entrance
  const logoEnter = spring({
    fps,
    frame: Math.max(0, frame - 4),
    config: { damping: 14, mass: 0.7 },
  });
  const logoScale = interpolate(logoEnter, [0, 1], [0.8, 1]);
  const logoOpacity = interpolate(logoEnter, [0, 1], [0, 1]);

  // Text entrance
  const textFrame = Math.max(0, frame - 14);
  const textOpacity = interpolate(textFrame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textY = interpolate(textFrame, [0, 12], [16, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <>
      {/* Green gradient flood — override ambient layer */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, #0d4a00 0%, #1a6b00 40%, #2d8a0e 70%, #4aaf1a 100%)",
          opacity: floodOpacity,
          zIndex: 3,
        }}
      />

      {/* CUTMV Logo */}
      <div
        style={{
          position: "absolute",
          top: "22%",
          left: 0,
          right: 0,
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

      {/* "MORE CONTENT. LESS WORK." */}
      <div
        style={{
          position: "absolute",
          top: "52%",
          left: SAFE.left,
          right: SAFE.right,
          textAlign: "center",
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
          zIndex: 10,
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
          MORE CONTENT.
        </div>
        <div
          style={{
            fontSize: 68,
            fontWeight: 900,
            color: "rgba(255,255,255,0.55)",
            textTransform: "uppercase",
            lineHeight: 1.1,
            fontFamily: "system-ui, sans-serif",
            marginTop: 8,
          }}
        >
          LESS WORK.
        </div>
      </div>

      {/* FD Logo — small at bottom */}
      <div
        style={{
          position: "absolute",
          bottom: SAFE.bottom + 40,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          opacity: textOpacity * 0.7,
          zIndex: 10,
        }}
      >
        <Img
          src={staticFile("cutmv/fd-logo-2025-white.png")}
          style={{ width: "18%", objectFit: "contain", opacity: 0.7 }}
        />
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════
// Main Composition
// ═══════════════════════════════════════════════
export const CutmvPremiumAdV5: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const scenes = [
    { start: 0, end: 2, Component: SceneHook },
    { start: 2, end: 6, Component: SceneUIRecreation },
    { start: 6, end: 8, Component: SceneCardStack },
    { start: 8, end: 10, Component: SceneCTA },
  ];

  const current = scenes.find((s) => t >= s.start && t < s.end);

  // Determine if we're in CTA scene (green gradient replaces ambient)
  const inCTA = t >= 8;

  // Ambient glow follows UI scenes
  const glowY = t < 6 ? "45%" : "55%";
  const glowSize = t < 6 ? 600 : 500;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Ambient atmosphere — behind everything */}
      {!inCTA && (
        <AmbientLayer
          glowY={glowY}
          glowSize={glowSize}
          glowOpacity={0.12}
          showGrain
          showParticles
          showVignette
        />
      )}

      {/* Active scene */}
      {current && (
        <current.Component
          frame={frame - Math.floor(current.start * fps)}
          fps={fps}
        />
      )}

      {/* Captions — always on top */}
      <Captions
        segments={CAPTION_SEGMENTS}
        safe={SAFE}
        y={1540}
      />
    </AbsoluteFill>
  );
};
