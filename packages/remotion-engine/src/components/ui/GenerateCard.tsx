/**
 * GenerateCard — Floating white card for output type.
 *
 * Based on reference frames 1733 / 1752:
 *   - "Generate Professional [GIFs/Thumbnails/Canvas]"
 *   - Pack description + credits
 *   - Toggle switch (on/off)
 *   - Quality note
 *   - White card with subtle shadow, tiltable
 */

import React from "react";

const GREEN = "#94F33F";

interface GenerateCardProps {
  title: string;
  subtitle: string;
  credits: string;
  note: string;
  toggleOn?: boolean;
  tiltDeg?: number;
  glowIntensity?: number;
}

// ── Toggle Switch ──
const ToggleSwitch: React.FC<{ on: boolean; glow?: number }> = ({
  on,
  glow = 0,
}) => (
  <div
    style={{
      width: 48,
      height: 28,
      borderRadius: 14,
      background: on ? GREEN : "#ddd",
      position: "relative",
      flexShrink: 0,
      boxShadow: on ? `0 0 ${12 + glow * 8}px ${GREEN}80` : "none",
      transition: "box-shadow 0.3s",
    }}
  >
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        background: "#fff",
        position: "absolute",
        top: 3,
        left: on ? 23 : 3,
        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }}
    />
  </div>
);

export const GenerateCard: React.FC<GenerateCardProps> = ({
  title,
  subtitle,
  credits,
  note,
  toggleOn = false,
  tiltDeg = 0,
  glowIntensity = 0,
}) => (
  <div
    style={{
      width: "100%",
      background: "#fff",
      borderRadius: 18,
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      boxShadow: `0 12px 40px rgba(0,0,0,0.25), 0 0 ${20 * glowIntensity}px rgba(148,243,63,${0.15 * glowIntensity})`,
      transform: `rotate(${tiltDeg}deg)`,
    }}
  >
    {/* Top row: title + toggle */}
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: "#111",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
      </div>
      <ToggleSwitch on={toggleOn} glow={glowIntensity} />
    </div>

    {/* Subtitle + credits */}
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#e8f5e9",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 9, color: "#4caf50" }}>✦</span>
      </div>
      <span
        style={{
          fontSize: 13,
          color: "#555",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {subtitle} – {credits}
      </span>
    </div>

    {/* Note */}
    <div
      style={{
        fontSize: 12,
        color: "#888",
        fontFamily: "system-ui, sans-serif",
        fontStyle: "italic",
      }}
    >
      {note}
    </div>
  </div>
);
