/**
 * CutmvOutputList — Code-based output format list.
 *
 * Shows CLIPS / GIFS / THUMBNAILS / CANVAS rows with
 * status indicators and optional highlight.
 *
 * Usage:
 *   <CutmvOutputList
 *     highlight="CLIPS"
 *     staggerFrame={localFrame}
 *     staggerDelay={4}
 *   />
 */

import React from "react";
import { interpolate } from "remotion";

const GREEN = "#94F33F";

interface OutputRow {
  label: string;
  count: string;
  status: "ready" | "generating" | "queued";
}

const DEFAULT_ROWS: OutputRow[] = [
  { label: "CLIPS", count: "12", status: "ready" },
  { label: "GIFS", count: "8", status: "ready" },
  { label: "THUMBNAILS", count: "24", status: "generating" },
  { label: "CANVAS", count: "6", status: "queued" },
];

const statusColor = (s: OutputRow["status"]) => {
  switch (s) {
    case "ready":
      return GREEN;
    case "generating":
      return "#FFB800";
    case "queued":
      return "rgba(255,255,255,0.3)";
  }
};

const statusLabel = (s: OutputRow["status"]) => {
  switch (s) {
    case "ready":
      return "READY";
    case "generating":
      return "GENERATING...";
    case "queued":
      return "QUEUED";
  }
};

export const CutmvOutputList: React.FC<{
  rows?: OutputRow[];
  highlight?: string;
  staggerFrame?: number;
  staggerDelay?: number;
}> = ({
  rows = DEFAULT_ROWS,
  highlight,
  staggerFrame = 30,
  staggerDelay = 4,
}) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        width: "100%",
      }}
    >
      {rows.map((row, i) => {
        const frame = Math.max(0, staggerFrame - i * staggerDelay);
        const opacity = interpolate(frame, [0, 6], [0, 1], {
          extrapolateRight: "clamp",
        });
        const slideX = interpolate(frame, [0, 6], [16, 0], {
          extrapolateRight: "clamp",
        });

        const isHighlight =
          highlight?.toUpperCase() === row.label.toUpperCase();

        return (
          <div
            key={row.label}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderRadius: 10,
              background: isHighlight
                ? "rgba(148,243,63,0.1)"
                : "rgba(255,255,255,0.04)",
              border: isHighlight
                ? "1px solid rgba(148,243,63,0.25)"
                : "1px solid rgba(255,255,255,0.06)",
              opacity,
              transform: `translateX(${slideX}px)`,
            }}
          >
            {/* Left: label + count */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  color: isHighlight ? GREEN : "#fff",
                  fontFamily: "system-ui, sans-serif",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {row.label}
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "rgba(255,255,255,0.35)",
                  fontFamily: "system-ui, sans-serif",
                }}
              >
                {row.count} FILES
              </span>
            </div>

            {/* Right: status */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  background: statusColor(row.status),
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: statusColor(row.status),
                  fontFamily: "system-ui, sans-serif",
                  letterSpacing: 0.5,
                }}
              >
                {statusLabel(row.status)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
