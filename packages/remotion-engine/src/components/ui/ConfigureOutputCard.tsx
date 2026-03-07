/**
 * ConfigureOutputCard — Reconstructed "Configure Output Options" panel.
 *
 * Based on reference frame 1677:
 *   - Header: "CONFIGURE OUTPUT OPTIONS"
 *   - Quick Start section with sparkle icon
 *   - "Auto Generate" button with green accent
 *   - Timestamp Format input field with green border
 *   - White card on dark background
 */

import React from "react";

const GREEN = "#94F33F";
const DARK_GREEN = "#2D7A0F";

export const ConfigureOutputCard: React.FC<{
  showTimestamp?: boolean;
}> = ({ showTimestamp = true }) => (
  <div
    style={{
      width: "100%",
      background: "#fff",
      borderRadius: 20,
      padding: 28,
      display: "flex",
      flexDirection: "column",
      gap: 18,
      boxShadow: "0 8px 40px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.2)",
    }}
  >
    {/* Header */}
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          border: "2px solid #999",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 12, color: "#666" }}>⏱</span>
      </div>
      <span
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "#111",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Configure Output Options
      </span>
    </div>

    {/* Quick Start */}
    <div
      style={{
        background: "#f8f8f8",
        borderRadius: 14,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: "#111",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Quick Start
      </div>
      <div
        style={{
          fontSize: 13,
          color: "#666",
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1.4,
        }}
      >
        ✨ Auto-generate clips based on video length
      </div>

      {/* Auto Generate Button */}
      <div
        style={{
          marginTop: 6,
          background: `linear-gradient(135deg, ${GREEN}20, ${GREEN}10)`,
          border: `1.5px solid ${GREEN}60`,
          borderRadius: 10,
          padding: "10px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 14, color: DARK_GREEN }}>✦</span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: DARK_GREEN,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          Auto Generate
        </span>
      </div>
    </div>

    {/* Timestamp Format */}
    {showTimestamp && (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#333",
              fontFamily: "system-ui, sans-serif",
            }}
          >
            Timestamp Format
          </span>
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              border: "1px solid #ccc",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 9, color: "#999" }}>i</span>
          </div>
        </div>
        <div
          style={{
            border: `2px solid ${GREEN}`,
            borderRadius: 12,
            padding: "14px 16px",
            background: "#fff",
          }}
        >
          <span
            style={{
              fontSize: 16,
              color: "#111",
              fontFamily: "monospace",
            }}
          >
            0:00–
          </span>
          <span
            style={{
              display: "inline-block",
              width: 2,
              height: 18,
              background: "#111",
              marginLeft: 1,
              verticalAlign: "middle",
            }}
          />
        </div>
        <div
          style={{
            fontSize: 12,
            color: GREEN,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          ✨ Automatically optimizing timestamps for best results
        </div>
      </div>
    )}
  </div>
);
