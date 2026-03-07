/**
 * EnvironmentLayer — Routes environment specs to their renderers.
 *
 * Renders at z-index 5 (behind scene content at z-index 10).
 * Provides the "context layer" that makes ads feel like real workflows
 * instead of floating cards.
 */
import React from "react";
import { Sequence, useCurrentFrame } from "remotion";
import type { EnvironmentSpec, ContextBadge } from "./types";
import type { BrandSystemConfig } from "../parser/MotionSpecTypes";
import { getBrandPhase } from "../overlays/BrandSystemOverlay";
import { PremiereTimelineEnvRenderer } from "./PremiereTimelineEnv";
import { AbstractBlobNoiseEnvRenderer } from "./AbstractBlobNoiseEnv";

// ── Context Badge (top-left label: "LIVE DEMO", "IN EDITOR", etc.) ──

const ContextBadgeOverlay: React.FC<{
  badge: string;
  green: string;
}> = ({ badge, green }) => {
  return (
    <div
      style={{
        position: "absolute",
        top: 52,
        left: 52,
        zIndex: 12,
        padding: "5px 14px",
        borderRadius: 8,
        background: "rgba(0,0,0,0.55)",
        border: `1px solid rgba(148,243,63,0.25)`,
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.5,
          color: green,
          fontFamily: "system-ui, sans-serif",
          textTransform: "uppercase",
        }}
      >
        {badge}
      </span>
    </div>
  );
};

// ── Gated context badge: hidden during hero open/close and endcard ──

const GatedContextBadge: React.FC<{
  badge: string;
  green: string;
  totalFrames: number;
  brandSystem?: BrandSystemConfig;
}> = ({ badge, green, totalFrames, brandSystem }) => {
  const frame = useCurrentFrame();
  const phase = getBrandPhase(frame, totalFrames, brandSystem);

  // Hide badge whenever hero or endcard is visible — no overlaps ever
  if (phase !== "none") return null;

  return <ContextBadgeOverlay badge={badge} green={green} />;
};

// ── Environment renderer router ──

const EnvironmentRenderer: React.FC<{
  env: EnvironmentSpec;
  width: number;
  height: number;
  green: string;
}> = ({ env, width, height, green }) => {
  switch (env.type) {
    case "premiere_timeline":
      return (
        <PremiereTimelineEnvRenderer
          env={env}
          width={width}
          height={height}
          green={green}
        />
      );

    case "abstract_blob_noise":
      return (
        <AbstractBlobNoiseEnvRenderer
          env={env}
          width={width}
          height={height}
          green={green}
        />
      );

    // Stub renderers for future environment types
    case "upload_workspace":
    case "social_feed":
    case "studio_backdrop":
      // For now, render as abstract with defaults
      return (
        <AbstractBlobNoiseEnvRenderer
          env={{
            type: "abstract_blob_noise",
            gradient: ["#0B0B0F", "#10121A"],
            noise: true,
            blobs: 2,
            greenAccent: true,
            movement: "slowDrift",
            vignette: 0.3,
          }}
          width={width}
          height={height}
          green={green}
        />
      );

    case "none":
    default:
      return null;
  }
};

// ── Exported: per-scene environment layer ──

export const SceneEnvironmentLayer: React.FC<{
  env: EnvironmentSpec;
  contextBadge?: ContextBadge;
  width: number;
  height: number;
  green: string;
  from: number;
  duration: number;
  totalFrames: number;
  brandSystem?: BrandSystemConfig;
}> = ({ env, contextBadge, width, height, green, from, duration, totalFrames, brandSystem }) => {
  if (env.type === "none") return null;

  return (
    <Sequence from={from} durationInFrames={duration}>
      <div style={{ position: "absolute", inset: 0, zIndex: 5 }}>
        <EnvironmentRenderer
          env={env}
          width={width}
          height={height}
          green={green}
        />
      </div>
      {contextBadge ? (
        <GatedContextBadge
          badge={contextBadge}
          green={green}
          totalFrames={totalFrames}
          brandSystem={brandSystem}
        />
      ) : null}
    </Sequence>
  );
};

// ── Bulk renderer for all scenes in a spec ──

export type SceneWithEnvironment = {
  id: string;
  from: number;
  duration: number;
  environment?: EnvironmentSpec;
  contextBadge?: ContextBadge;
};

export const EnvironmentLayerStack: React.FC<{
  scenes: SceneWithEnvironment[];
  width: number;
  height: number;
  green: string;
  totalFrames: number;
  brandSystem?: BrandSystemConfig;
}> = ({ scenes, width, height, green, totalFrames, brandSystem }) => {
  return (
    <>
      {scenes.map((s) => {
        if (!s.environment || s.environment.type === "none") return null;
        return (
          <SceneEnvironmentLayer
            key={`env-${s.id}`}
            env={s.environment}
            contextBadge={s.contextBadge}
            width={width}
            height={height}
            green={green}
            from={s.from}
            duration={s.duration}
            totalFrames={totalFrames}
            brandSystem={brandSystem}
          />
        );
      })}
    </>
  );
};
