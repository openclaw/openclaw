/**
 * AmbientLayer — Premium visual atmosphere.
 *
 * Provides:
 *   - Deep black to charcoal gradient background
 *   - Soft green radial glow (animated)
 *   - Film grain texture (subtle noise)
 *   - Vignette edges
 *   - Floating particle noise (dots)
 *
 * Renders behind all content at z-index 0.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

const GREEN = "#94F33F";

// ── Grain noise layer (CSS-based) ──
const GrainLayer: React.FC = () => {
  const frame = useCurrentFrame();
  // Shift grain pattern every frame for animated feel
  const offsetX = (frame * 7) % 200;
  const offsetY = (frame * 11) % 200;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: 0.04,
        // eslint-disable-next-line @remotion/no-background-image -- inline SVG data URI, not an external asset
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
        backgroundSize: "200px 200px",
        zIndex: 1,
        pointerEvents: "none",
      }}
    />
  );
};

// ── Green radial glow ──
const GreenGlow: React.FC<{
  x?: string;
  y?: string;
  size?: number;
  opacity?: number;
}> = ({ x = "50%", y = "45%", size = 600, opacity = 0.12 }) => {
  const frame = useCurrentFrame();
  // Subtle breathing animation
  const breathe = interpolate(Math.sin(frame * 0.04), [-1, 1], [0.9, 1.1]);

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: size * breathe,
        height: size * breathe,
        marginLeft: -(size * breathe) / 2,
        marginTop: -(size * breathe) / 2,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${GREEN}${Math.round(opacity * 255)
          .toString(16)
          .padStart(2, "0")} 0%, transparent 70%)`,
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
};

// ── Vignette ──
const Vignette: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)",
      zIndex: 2,
      pointerEvents: "none",
    }}
  />
);

// ── Floating particles ──
const Particles: React.FC = () => {
  const frame = useCurrentFrame();
  useVideoConfig(); // fps available if needed

  // 8 subtle floating dots
  const particles = Array.from({ length: 8 }, (_, i) => {
    const baseX = 100 + ((i * 137) % 880);
    const baseY = 200 + ((i * 211) % 1520);
    const speed = 0.3 + (i % 3) * 0.15;
    const size = 2 + (i % 3);

    const y = baseY - ((frame * speed) % 400);
    const x = baseX + Math.sin(frame * 0.02 + i) * 20;
    const opacity = interpolate(
      y,
      [baseY - 400, baseY - 300, baseY - 100, baseY],
      [0, 0.3, 0.3, 0],
    );

    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: size,
          height: size,
          borderRadius: size / 2,
          background: `rgba(255,255,255,${opacity})`,
          pointerEvents: "none",
        }}
      />
    );
  });

  return <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>{particles}</div>;
};

// ── Main Ambient Layer ──
export const AmbientLayer: React.FC<{
  glowX?: string;
  glowY?: string;
  glowSize?: number;
  glowOpacity?: number;
  showGrain?: boolean;
  showParticles?: boolean;
  showVignette?: boolean;
}> = ({
  glowX = "50%",
  glowY = "45%",
  glowSize = 600,
  glowOpacity = 0.12,
  showGrain = true,
  showParticles = true,
  showVignette = true,
}) => (
  <>
    {/* Base gradient: deep black → charcoal */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(180deg, #0a0a0a 0%, #141414 50%, #0d0d0d 100%)",
        zIndex: 0,
      }}
    />

    <GreenGlow x={glowX} y={glowY} size={glowSize} opacity={glowOpacity} />

    {showGrain && <GrainLayer />}
    {showParticles && <Particles />}
    {showVignette && <Vignette />}
  </>
);
