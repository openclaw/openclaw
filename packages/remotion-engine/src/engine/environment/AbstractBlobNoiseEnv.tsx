/**
 * AbstractBlobNoiseEnv — Procedural animated gradient blobs + noise.
 *
 * Creates cinematic depth with:
 * - Soft radial blobs (animated drift)
 * - Ultra-subtle noise layer
 * - Optional green accent bloom
 * - Vignette overlay
 *
 * Max movement: ~0.4px/frame (never distracting).
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import type { AbstractBlobNoiseEnvSpec } from "./types";

export const AbstractBlobNoiseEnvRenderer: React.FC<{
  env: AbstractBlobNoiseEnvSpec;
  width: number;
  height: number;
  green: string;
}> = ({ env, width: _width, height: _height, green }) => {
  const frame = useCurrentFrame();

  const grad = env.gradient ?? ["#0B0B0F", "#11131A"];
  const showNoise = env.noise ?? true;
  const blobCount = env.blobs ?? 2;
  const greenAccent = env.greenAccent ?? true;
  const movement = env.movement ?? "slowDrift";
  const blur = env.blur ?? 0;
  const vignette = env.vignette ?? 0.3;

  // ── Movement calculations ──
  const isDrift = movement === "slowDrift" || movement === "breathe";
  const isPulse = movement === "pulse" || movement === "breathe";

  // Blob positions (deterministic, frame-driven)
  const blobs = Array.from({ length: blobCount }, (_, i) => {
    const phase = (i * Math.PI * 2) / blobCount;
    const speed = 0.005 + i * 0.002;

    const cx = isDrift
      ? 30 + 40 * (i / Math.max(1, blobCount - 1)) + Math.sin(frame * speed + phase) * 12
      : 30 + 40 * (i / Math.max(1, blobCount - 1));

    const cy = isDrift
      ? 25 + 30 * (i / Math.max(1, blobCount - 1)) + Math.cos(frame * speed * 0.8 + phase) * 10
      : 25 + 30 * (i / Math.max(1, blobCount - 1));

    const scale = isPulse ? 1 + Math.sin(frame * 0.03 + phase) * 0.06 : 1;

    const opacity = 0.12 + i * 0.04;

    return { cx, cy, scale, opacity };
  });

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* Base gradient */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(180deg, ${grad[0]} 0%, ${grad[1]} 100%)`,
        }}
      />

      {/* Blobs */}
      {blobs.map((blob, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            inset: -200,
            opacity: blob.opacity,
            transform: `scale(${blob.scale})`,
            background: `radial-gradient(circle at ${blob.cx}% ${blob.cy}%, rgba(255,255,255,0.08), transparent 50%)`,
            filter: "blur(80px)",
          }}
        />
      ))}

      {/* Green accent bloom */}
      {greenAccent ? (
        <div
          style={{
            position: "absolute",
            inset: -300,
            opacity: 0.08 + (isPulse ? Math.sin(frame * 0.035) * 0.03 : 0),
            background: `radial-gradient(circle at 50% 35%, ${green}30, transparent 55%)`,
            filter: "blur(60px)",
            transform: isDrift
              ? `translate(${Math.sin(frame * 0.006) * 15}px, ${Math.cos(frame * 0.008) * 10}px)`
              : undefined,
          }}
        />
      ) : null}

      {/* Noise */}
      {showNoise ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.15,
            backgroundImage: `repeating-linear-gradient(
              0deg, transparent, transparent 1px, rgba(255,255,255,0.015) 1px, rgba(255,255,255,0.015) 2px
            ), repeating-linear-gradient(
              90deg, transparent, transparent 1px, rgba(255,255,255,0.01) 1px, rgba(255,255,255,0.01) 2px
            )`,
            transform: `translateY(${Math.sin(frame * 0.5) * 1}px)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Blur overlay */}
      {blur > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backdropFilter: `blur(${blur * 12}px)`,
            WebkitBackdropFilter: `blur(${blur * 12}px)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Vignette */}
      {vignette > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(circle at 50% 50%, transparent 50%, rgba(0,0,0,${vignette * 0.7}) 100%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  );
};
