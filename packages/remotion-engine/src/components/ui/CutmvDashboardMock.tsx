/**
 * CutmvDashboardMock — Code-based recreation of CUTMV dashboard UI.
 *
 * Replaces screenshot usage with deterministic rendered UI.
 * Variants:
 *   - output_config: output format configuration panel
 *   - upload: upload flow screen
 *
 * Uses exact CUTMV brand colors:
 *   - Background: #0a0a0a / #111
 *   - Green accent: #94F33F
 *   - White text: #fff
 *   - Muted: rgba(255,255,255,0.5)
 */

import React from "react";

const GREEN = "#94F33F";

type DashboardVariant = "output_config" | "upload";

// ── Format Pill ──
const FormatPill: React.FC<{
  label: string;
  active?: boolean;
}> = ({ label, active = false }) => (
  <div
    style={{
      padding: "8px 18px",
      borderRadius: 20,
      background: active ? GREEN : "rgba(255,255,255,0.08)",
      color: active ? "#000" : "rgba(255,255,255,0.7)",
      fontSize: 16,
      fontWeight: 700,
      fontFamily: "system-ui, sans-serif",
      letterSpacing: 0.5,
    }}
  >
    {label}
  </div>
);

// ── Toggle Row ──
const ToggleRow: React.FC<{
  label: string;
  on?: boolean;
}> = ({ label, on = false }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 0",
    }}
  >
    <span
      style={{
        fontSize: 15,
        fontWeight: 600,
        color: "rgba(255,255,255,0.75)",
        fontFamily: "system-ui, sans-serif",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {label}
    </span>
    <div
      style={{
        width: 38,
        height: 22,
        borderRadius: 11,
        background: on ? GREEN : "rgba(255,255,255,0.15)",
        position: "relative",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: on ? "#000" : "rgba(255,255,255,0.4)",
          position: "absolute",
          top: 3,
          left: on ? 19 : 3,
        }}
      />
    </div>
  </div>
);

// ── Primary Button ──
const PrimaryButton: React.FC<{ label: string }> = ({ label }) => (
  <div
    style={{
      background: GREEN,
      color: "#000",
      fontSize: 16,
      fontWeight: 800,
      fontFamily: "system-ui, sans-serif",
      textTransform: "uppercase",
      letterSpacing: 1,
      padding: "14px 28px",
      borderRadius: 12,
      textAlign: "center",
    }}
  >
    {label}
  </div>
);

// ── Section Header ──
const SectionHeader: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      fontSize: 12,
      fontWeight: 700,
      color: "rgba(255,255,255,0.35)",
      fontFamily: "system-ui, sans-serif",
      textTransform: "uppercase",
      letterSpacing: 2,
      marginBottom: 12,
    }}
  >
    {text}
  </div>
);

// ── Output Config Variant ──
const OutputConfigPanel: React.FC = () => (
  <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
    {/* Header */}
    <div
      style={{
        fontSize: 20,
        fontWeight: 800,
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      CONFIGURE OUTPUT OPTIONS
    </div>

    {/* Quick Start badge */}
    <div
      style={{
        display: "inline-flex",
        alignSelf: "flex-start",
        padding: "6px 14px",
        borderRadius: 8,
        background: "rgba(148,243,63,0.12)",
        border: "1px solid rgba(148,243,63,0.25)",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: GREEN,
          fontFamily: "system-ui, sans-serif",
          textTransform: "uppercase",
          letterSpacing: 1,
        }}
      >
        QUICK START
      </span>
    </div>

    {/* Format pills */}
    <div>
      <SectionHeader text="ASPECT RATIO" />
      <div style={{ display: "flex", gap: 10 }}>
        <FormatPill label="9:16" active />
        <FormatPill label="1:1" />
        <FormatPill label="16:9" />
      </div>
    </div>

    {/* Output toggles */}
    <div>
      <SectionHeader text="OUTPUT FORMATS" />
      <ToggleRow label="CLIPS" on />
      <ToggleRow label="GIFS" on />
      <ToggleRow label="THUMBNAILS" on />
      <ToggleRow label="CANVAS" />
    </div>

    {/* CTA button */}
    <div style={{ marginTop: 8 }}>
      <PrimaryButton label="START CREATING NOW" />
    </div>
  </div>
);

// ── Upload Variant ──
const UploadPanel: React.FC = () => (
  <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
    <div
      style={{
        fontSize: 20,
        fontWeight: 800,
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        textTransform: "uppercase",
      }}
    >
      UPLOAD YOUR VIDEO
    </div>

    {/* Upload dropzone */}
    <div
      style={{
        height: 160,
        border: "2px dashed rgba(148,243,63,0.3)",
        borderRadius: 16,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          background: "rgba(148,243,63,0.12)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 24, color: GREEN }}>+</span>
      </div>
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "rgba(255,255,255,0.5)",
          fontFamily: "system-ui, sans-serif",
          textTransform: "uppercase",
        }}
      >
        DROP VIDEO OR BROWSE
      </span>
    </div>

    {/* Supported formats */}
    <div style={{ display: "flex", gap: 8 }}>
      {["MP4", "MOV", "AVI"].map((fmt) => (
        <span
          key={fmt}
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "rgba(255,255,255,0.3)",
            fontFamily: "system-ui, sans-serif",
            padding: "4px 10px",
            background: "rgba(255,255,255,0.05)",
            borderRadius: 6,
          }}
        >
          {fmt}
        </span>
      ))}
    </div>

    <PrimaryButton label="UPLOAD & GENERATE" />
  </div>
);

// ── Main Component ──
export const CutmvDashboardMock: React.FC<{
  variant?: DashboardVariant;
}> = ({ variant = "output_config" }) => {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#0a0a0a",
        overflow: "hidden",
      }}
    >
      {variant === "output_config" ? <OutputConfigPanel /> : <UploadPanel />}
    </div>
  );
};
