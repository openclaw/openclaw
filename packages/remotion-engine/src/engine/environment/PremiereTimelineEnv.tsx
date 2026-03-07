/**
 * PremiereTimelineEnv — Procedural synthetic NLE timeline renderer.
 *
 * Draws a fake editing timeline with:
 * - Time ruler + ticks + timecodes
 * - Track sidebar (V1..Vn, A1..An)
 * - Clip rectangles with colors, labels, waveforms
 * - Playhead line + head triangle
 * - Green markers
 * - Slow scroll + parallax camera
 * - Post-processing: blur, vignette, grain
 *
 * NOT pixel-perfect Premiere — just enough that the brain reads "editing software".
 */
import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import type { PremiereTimelineEnvSpec, PremierePresetName } from "./types";
import { createPRNG, randRange, randPick } from "./prng";
import { clamp, easeInOutCubic } from "../motion/easings";

// ── Preset defaults ──

type PresetDefaults = {
  tracks: { video: number; audio: number };
  cutsDensity: "low" | "med" | "high";
  scrollSpeed: number;
  labels: boolean;
  waveforms: boolean;
  markers: boolean;
};

const PRESETS: Record<PremierePresetName, PresetDefaults> = {
  music_video_dense: {
    tracks: { video: 4, audio: 3 },
    cutsDensity: "high",
    scrollSpeed: 2.1,
    labels: true,
    waveforms: true,
    markers: true,
  },
  music_video_clean: {
    tracks: { video: 3, audio: 2 },
    cutsDensity: "med",
    scrollSpeed: 1.6,
    labels: true,
    waveforms: true,
    markers: false,
  },
  tutorial_talkinghead: {
    tracks: { video: 2, audio: 2 },
    cutsDensity: "low",
    scrollSpeed: 1.2,
    labels: true,
    waveforms: true,
    markers: false,
  },
  ugc_fastcuts: {
    tracks: { video: 3, audio: 2 },
    cutsDensity: "high",
    scrollSpeed: 2.8,
    labels: false,
    waveforms: true,
    markers: true,
  },
  cinematic_sparse: {
    tracks: { video: 3, audio: 2 },
    cutsDensity: "low",
    scrollSpeed: 1.2,
    labels: false,
    waveforms: true,
    markers: false,
  },
};

// ── Clip color palettes (muted, NLE-style) ──

const VIDEO_COLORS = [
  "rgba(82, 110, 170, 0.65)",   // muted blue
  "rgba(120, 85, 155, 0.60)",   // muted purple
  "rgba(72, 130, 140, 0.60)",   // teal
  "rgba(95, 95, 120, 0.55)",    // grey-blue
  "rgba(65, 105, 85, 0.55)",    // dark green
  "rgba(140, 100, 80, 0.50)",   // warm brown
];

const AUDIO_COLORS = [
  "rgba(80, 155, 80, 0.55)",    // green audio
  "rgba(60, 130, 60, 0.50)",    // darker green
  "rgba(100, 170, 100, 0.45)",  // light green
];

const CLIP_LABELS_VIDEO = [
  "MV_TAKE_01", "MV_TAKE_02", "MV_TAKE_03", "BROLL_01", "BROLL_02",
  "CUT_01", "CUT_02", "CUT_03", "INSERT_A", "INSERT_B",
  "WIDE_01", "CLOSE_01", "PERF_01", "PERF_02", "PERF_03",
];

const CLIP_LABELS_AUDIO = [
  "MASTER", "VOCAL", "BEAT", "SFX_01", "SFX_02", "MUSIC_BED", "VO_01",
];

// ── Clip data structure ──

type ClipData = {
  x: number;
  w: number;
  trackIndex: number;
  isAudio: boolean;
  color: string;
  label?: string;
  waveformBars: number[]; // 0..1 heights for waveform
};

// ── Generate deterministic clip layout ──

function generateClips(
  rng: () => number,
  videoTracks: number,
  audioTracks: number,
  totalWidth: number,
  density: "low" | "med" | "high",
  showLabels: boolean,
  showWaveforms: boolean,
): ClipData[] {
  const clips: ClipData[] = [];

  const avgClipW =
    density === "high" ? { min: 40, max: 100 } :
    density === "med" ? { min: 80, max: 180 } :
    { min: 150, max: 320 };

  const gapW =
    density === "high" ? { min: 2, max: 6 } :
    density === "med" ? { min: 4, max: 12 } :
    { min: 6, max: 20 };

  // Generate video tracks
  for (let t = 0; t < videoTracks; t++) {
    let x = randRange(rng, 0, 30);
    // V1 = base layer (longer clips), upper tracks = shorter overlays
    const lengthMul = t === 0 ? 1.8 : t === 1 ? 1.2 : 0.7;

    while (x < totalWidth + 200) {
      const w = randRange(rng, avgClipW.min * lengthMul, avgClipW.max * lengthMul);
      const barCount = Math.min(40, Math.max(8, Math.floor(w / 3)));

      clips.push({
        x,
        w,
        trackIndex: t,
        isAudio: false,
        color: randPick(rng, VIDEO_COLORS),
        label: showLabels ? randPick(rng, CLIP_LABELS_VIDEO) : undefined,
        waveformBars: Array.from({ length: barCount }, () =>
          0.15 + rng() * 0.65
        ),
      });

      x += w + randRange(rng, gapW.min, gapW.max);

      // Upper tracks have gaps (not continuous)
      if (t > 1 && rng() > 0.6) {
        x += randRange(rng, 30, 120);
      }
    }
  }

  // Generate audio tracks
  for (let t = 0; t < audioTracks; t++) {
    let x = randRange(rng, 0, 10);
    // A1 = continuous bed, A2/A3 = shorter bursts
    const lengthMul = t === 0 ? 3.0 : 0.8;

    while (x < totalWidth + 200) {
      const w = randRange(rng, avgClipW.min * lengthMul, avgClipW.max * lengthMul);
      const barCount = showWaveforms ? Math.min(40, Math.max(10, Math.floor(w / 3))) : 0;

      clips.push({
        x,
        w,
        trackIndex: videoTracks + t,
        isAudio: true,
        color: randPick(rng, AUDIO_COLORS),
        label: showLabels ? randPick(rng, CLIP_LABELS_AUDIO) : undefined,
        waveformBars: Array.from({ length: barCount }, () =>
          0.1 + rng() * 0.7
        ),
      });

      x += w + randRange(rng, gapW.min, gapW.max);

      // A2/A3 have larger gaps
      if (t > 0 && rng() > 0.5) {
        x += randRange(rng, 50, 200);
      }
    }
  }

  return clips;
}

// ── Sub-components ──

const TimeRuler: React.FC<{
  scrollX: number;
  width: number;
  rulerH: number;
  sidebarW: number;
  green: string;
  markersEnabled: boolean;
  markerEvery: number;
  markerColor: string;
  pxPerSecond: number;
}> = ({ scrollX, width, rulerH, sidebarW, green, markersEnabled, markerEvery, markerColor, pxPerSecond }) => {
  const ticks: React.ReactNode[] = [];
  const startSec = Math.floor(scrollX / pxPerSecond);
  const endSec = Math.ceil((scrollX + width) / pxPerSecond) + 1;

  for (let s = Math.max(0, startSec - 1); s <= endSec; s++) {
    const xPos = s * pxPerSecond - scrollX + sidebarW;

    // Major tick every 1s
    ticks.push(
      <div
        key={`tick-${s}`}
        style={{
          position: "absolute",
          left: xPos,
          top: rulerH - 16,
          width: 1,
          height: 16,
          background: "rgba(255,255,255,0.25)",
        }}
      />
    );

    // Timecode label every 2s
    if (s % 2 === 0) {
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      ticks.push(
        <div
          key={`label-${s}`}
          style={{
            position: "absolute",
            left: xPos + 4,
            top: 4,
            fontSize: 10,
            fontFamily: "monospace",
            color: "rgba(255,255,255,0.35)",
            whiteSpace: "nowrap",
          }}
        >
          {mm}:{ss}:00
        </div>
      );
    }

    // Minor ticks every 0.25s
    for (let q = 1; q < 4; q++) {
      const qx = xPos + (q * pxPerSecond) / 4;
      ticks.push(
        <div
          key={`qtick-${s}-${q}`}
          style={{
            position: "absolute",
            left: qx,
            top: rulerH - 8,
            width: 1,
            height: 8,
            background: "rgba(255,255,255,0.12)",
          }}
        />
      );
    }

    // Markers
    if (markersEnabled && s > 0 && s % markerEvery === 0) {
      ticks.push(
        <div
          key={`marker-${s}`}
          style={{
            position: "absolute",
            left: xPos,
            top: rulerH - 4,
            width: 6,
            height: 6,
            borderRadius: 3,
            background: markerColor,
          }}
        />
      );
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: rulerH,
        background: "rgba(18, 20, 26, 0.95)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        overflow: "hidden",
      }}
    >
      {ticks}
    </div>
  );
};

const TrackSidebar: React.FC<{
  videoTracks: number;
  audioTracks: number;
  sidebarW: number;
  rowH: number;
  gapH: number;
  rulerH: number;
  green: string;
}> = ({ videoTracks, audioTracks, sidebarW, rowH, gapH, rulerH, green }) => {
  const labels: React.ReactNode[] = [];
  const totalTracks = videoTracks + audioTracks;

  for (let i = 0; i < totalTracks; i++) {
    const isAudio = i >= videoTracks;
    const label = isAudio ? `A${i - videoTracks + 1}` : `V${i + 1}`;
    const y = rulerH + i * (rowH + gapH) + rowH / 2;

    labels.push(
      <div
        key={`label-${i}`}
        style={{
          position: "absolute",
          left: 8,
          top: y - 8,
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: 700,
          color: isAudio
            ? "rgba(100,180,100,0.6)"
            : "rgba(150,170,210,0.6)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    );

    // Decorative solo/mute dots
    labels.push(
      <div
        key={`dot-s-${i}`}
        style={{
          position: "absolute",
          right: 22,
          top: y - 3,
          width: 6,
          height: 6,
          borderRadius: 3,
          background: "rgba(255,255,255,0.12)",
        }}
      />,
      <div
        key={`dot-m-${i}`}
        style={{
          position: "absolute",
          right: 10,
          top: y - 3,
          width: 6,
          height: 6,
          borderRadius: 3,
          background: "rgba(255,255,255,0.08)",
        }}
      />
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: sidebarW,
        bottom: 0,
        background: "rgba(14, 16, 22, 0.92)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
        zIndex: 2,
      }}
    >
      {labels}
    </div>
  );
};

const ClipBlock: React.FC<{
  clip: ClipData;
  scrollX: number;
  sidebarW: number;
  rowH: number;
  gapH: number;
  rulerH: number;
  clipStyle: "square" | "rounded";
  waveformOpacity: number;
  waveformStyle: "bars" | "line";
}> = ({ clip, scrollX, sidebarW, rowH, gapH, rulerH, clipStyle, waveformOpacity, waveformStyle }) => {
  const x = clip.x - scrollX + sidebarW;
  const y = rulerH + clip.trackIndex * (rowH + gapH) + 2;
  const h = rowH - 4;

  // Skip if off-screen
  if (x + clip.w < -50 || x > 1200) return null;

  const borderRadius = clipStyle === "rounded" ? 4 : 0;

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: clip.w,
        height: h,
        borderRadius,
        background: clip.color,
        border: "1px solid rgba(255,255,255,0.06)",
        overflow: "hidden",
      }}
    >
      {/* Label */}
      {clip.label ? (
        <div
          style={{
            position: "absolute",
            top: 3,
            left: 5,
            fontSize: 9,
            fontFamily: "monospace",
            fontWeight: 600,
            color: "rgba(255,255,255,0.45)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            maxWidth: clip.w - 10,
          }}
        >
          {clip.label}
        </div>
      ) : null}

      {/* Waveform */}
      {clip.isAudio && clip.waveformBars.length > 0 ? (
        <div
          style={{
            position: "absolute",
            bottom: 2,
            left: 2,
            right: 2,
            height: h * 0.6,
            display: "flex",
            alignItems: "flex-end",
            gap: 1,
            opacity: waveformOpacity,
          }}
        >
          {clip.waveformBars.map((barH, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${barH * 100}%`,
                background:
                  waveformStyle === "bars"
                    ? "rgba(255,255,255,0.35)"
                    : "rgba(255,255,255,0.20)",
                borderRadius: waveformStyle === "bars" ? 1 : 0,
                minWidth: 1,
                maxWidth: 4,
              }}
            />
          ))}
        </div>
      ) : null}

      {/* Video clip diagonal stripes (subtle texture) */}
      {!clip.isAudio ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.06,
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent, transparent 6px, rgba(255,255,255,0.4) 6px, rgba(255,255,255,0.4) 7px)",
          }}
        />
      ) : null}
    </div>
  );
};

const Playhead: React.FC<{
  x: number;
  rulerH: number;
  totalH: number;
  color: string;
  glow: string;
  widthPx: number;
  headSize: number;
}> = ({ x, rulerH, totalH, color, glow, widthPx, headSize }) => {
  return (
    <>
      {/* Glow */}
      <div
        style={{
          position: "absolute",
          left: x - 8,
          top: rulerH,
          width: 16,
          bottom: 0,
          background: `linear-gradient(180deg, ${glow}, transparent)`,
          filter: "blur(6px)",
          pointerEvents: "none",
        }}
      />
      {/* Line */}
      <div
        style={{
          position: "absolute",
          left: x - widthPx / 2,
          top: rulerH,
          width: widthPx,
          bottom: 0,
          background: color,
          pointerEvents: "none",
        }}
      />
      {/* Head triangle */}
      <div
        style={{
          position: "absolute",
          left: x - headSize / 2,
          top: rulerH - headSize + 2,
          width: 0,
          height: 0,
          borderLeft: `${headSize / 2}px solid transparent`,
          borderRight: `${headSize / 2}px solid transparent`,
          borderTop: `${headSize}px solid ${color}`,
          pointerEvents: "none",
        }}
      />
    </>
  );
};

// ── Track lane backgrounds ──

const TrackLanes: React.FC<{
  totalTracks: number;
  rowH: number;
  gapH: number;
  rulerH: number;
  sidebarW: number;
  videoTracks: number;
}> = ({ totalTracks, rowH, gapH, rulerH, sidebarW, videoTracks }) => {
  return (
    <>
      {Array.from({ length: totalTracks }, (_, i) => (
        <div
          key={`lane-${i}`}
          style={{
            position: "absolute",
            left: sidebarW,
            right: 0,
            top: rulerH + i * (rowH + gapH),
            height: rowH,
            background:
              i % 2 === 0
                ? "rgba(255,255,255,0.015)"
                : "transparent",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
          }}
        />
      ))}
      {/* Divider between video and audio */}
      <div
        style={{
          position: "absolute",
          left: sidebarW,
          right: 0,
          top: rulerH + videoTracks * (rowH + gapH) - gapH / 2,
          height: 1,
          background: "rgba(255,255,255,0.08)",
        }}
      />
    </>
  );
};

// ── Main Component ──

export const PremiereTimelineEnvRenderer: React.FC<{
  env: PremiereTimelineEnvSpec;
  width: number;
  height: number;
  green: string;
}> = ({ env, width, height, green }) => {
  const frame = useCurrentFrame();
  const preset = PRESETS[env.preset ?? "music_video_dense"];

  // Resolve config with defaults
  const seed = env.seed ?? 1337;
  const videoTracks = env.timeline?.tracks?.video ?? preset.tracks.video;
  const audioTracks = env.timeline?.tracks?.audio ?? preset.tracks.audio;
  const totalTracks = videoTracks + audioTracks;
  const rowH = env.timeline?.rowHeightPx ?? 64;
  const gapH = env.timeline?.gapPx ?? 10;
  const rulerH = env.timeline?.rulerHeightPx ?? 44;
  const sidebarW = env.timeline?.sidebarWidthPx ?? 120;

  const scrollSpeed = env.scroll?.speedPxPerFrame ?? preset.scrollSpeed;
  const scrollLoop = env.scroll?.loop ?? true;

  const playheadEnabled = env.playhead?.enabled ?? true;
  const playheadXMode = env.playhead?.xMode ?? "fixed_center";
  const playheadColor = env.playhead?.color ?? "rgba(255,255,255,0.9)";
  const playheadGlow = env.playhead?.glow ?? "rgba(148,243,63,0.35)";
  const playheadWidthPx = env.playhead?.widthPx ?? 2;
  const playheadHeadSize = env.playhead?.headSizePx ?? 14;

  const density = env.content?.cutsDensity ?? preset.cutsDensity;
  const clipStyle = env.content?.clipStyle ?? "rounded";
  const showLabels = env.content?.labels ?? preset.labels;
  const waveformsEnabled = env.content?.waveforms?.enabled ?? preset.waveforms;
  const waveformStyle = env.content?.waveforms?.style ?? "bars";
  const waveformOpacity = env.content?.waveforms?.opacity ?? 0.55;
  const markersEnabled = env.content?.markers?.enabled ?? preset.markers;
  const markerEvery = env.content?.markers?.everyBeats ?? 4;
  const markerColor = env.content?.markers?.color ?? "rgba(148,243,63,0.55)";

  const durationSec = env.content?.durationSeconds ?? 16;
  const pxPerSecond = 220;
  const totalTimelineWidth = durationSec * pxPerSecond;

  // Post-processing
  const postBlur = env.post?.blur ?? env.timeline?.blur ?? 0.65;
  const postVignette = env.post?.vignette ?? env.timeline?.vignette ?? 0.35;
  const postGrain = env.post?.grain ?? env.timeline?.grain ?? 0.2;

  // Camera
  const cameraMode = env.camera?.mode ?? "slowPan";
  const driftPxX = env.camera?.driftPx?.x ?? 24;
  const driftPxY = env.camera?.driftPx?.y ?? 10;
  const zoomFrom = env.camera?.zoom?.from ?? 1.02;
  const zoomTo = env.camera?.zoom?.to ?? 1.05;

  // ── Generate clips (memoized by seed) ──
  const clips = useMemo(
    () => {
      const rng = createPRNG(seed);
      return generateClips(
        rng,
        videoTracks,
        audioTracks,
        totalTimelineWidth,
        density,
        showLabels,
        waveformsEnabled,
      );
    },
    [seed, videoTracks, audioTracks, totalTimelineWidth, density, showLabels, waveformsEnabled],
  );

  // ── Scroll offset ──
  let scrollX = frame * scrollSpeed;
  if (scrollLoop && totalTimelineWidth > 0) {
    scrollX = scrollX % totalTimelineWidth;
  }

  // ── Playhead position ──
  const playheadX =
    playheadXMode === "fixed_center"
      ? sidebarW + (width - sidebarW) / 2
      : sidebarW + 200 + frame * 1.5;

  // ── Camera transform ──
  const cameraT = clamp(frame / 300, 0, 1);
  const camDriftX =
    cameraMode === "slowPan" ? Math.sin(frame / 180) * driftPxX :
    cameraMode === "breathingZoom" ? Math.sin(frame / 200) * (driftPxX * 0.3) :
    0;
  const camDriftY =
    cameraMode === "slowPan" ? Math.cos(frame / 220) * driftPxY :
    cameraMode === "slowPanVertical" ? Math.sin(frame / 160) * driftPxY :
    0;
  const camZoom = zoomFrom + (zoomTo - zoomFrom) * easeInOutCubic(cameraT);

  // ── Total content height ──
  const contentH = rulerH + totalTracks * (rowH + gapH);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* Camera wrapper */}
      <div
        style={{
          position: "absolute",
          inset: -60,
          transform: `translate(${camDriftX}px, ${camDriftY}px) scale(${camZoom})`,
          transformOrigin: "50% 50%",
        }}
      >
        {/* Dark background */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(180deg, #0C0E14 0%, #0A0C10 100%)",
          }}
        />

        {/* Track lanes */}
        <TrackLanes
          totalTracks={totalTracks}
          rowH={rowH}
          gapH={gapH}
          rulerH={rulerH}
          sidebarW={sidebarW}
          videoTracks={videoTracks}
        />

        {/* Clips */}
        {clips.map((clip, i) => (
          <ClipBlock
            key={i}
            clip={clip}
            scrollX={scrollX}
            sidebarW={sidebarW}
            rowH={rowH}
            gapH={gapH}
            rulerH={rulerH}
            clipStyle={clipStyle}
            waveformOpacity={waveformOpacity}
            waveformStyle={waveformStyle}
          />
        ))}

        {/* Time ruler */}
        <TimeRuler
          scrollX={scrollX}
          width={width + 120}
          rulerH={rulerH}
          sidebarW={sidebarW}
          green={green}
          markersEnabled={markersEnabled}
          markerEvery={markerEvery}
          markerColor={markerColor}
          pxPerSecond={pxPerSecond}
        />

        {/* Track sidebar */}
        <TrackSidebar
          videoTracks={videoTracks}
          audioTracks={audioTracks}
          sidebarW={sidebarW}
          rowH={rowH}
          gapH={gapH}
          rulerH={rulerH}
          green={green}
        />

        {/* Playhead */}
        {playheadEnabled ? (
          <Playhead
            x={playheadX}
            rulerH={rulerH}
            totalH={contentH}
            color={playheadColor}
            glow={playheadGlow}
            widthPx={playheadWidthPx}
            headSize={playheadHeadSize}
          />
        ) : null}
      </div>

      {/* ── Post-processing stack ── */}

      {/* Blur */}
      {postBlur > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backdropFilter: `blur(${postBlur * 18}px)`,
            WebkitBackdropFilter: `blur(${postBlur * 18}px)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Vignette */}
      {postVignette > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(circle at 50% 50%, transparent 40%, rgba(0,0,0,${postVignette * 0.8}) 100%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Grain */}
      {postGrain > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: postGrain,
            backgroundImage: `repeating-linear-gradient(
              0deg, transparent, transparent 1px, rgba(255,255,255,0.02) 1px, rgba(255,255,255,0.02) 2px
            ), repeating-linear-gradient(
              90deg, transparent, transparent 1px, rgba(255,255,255,0.015) 1px, rgba(255,255,255,0.015) 2px
            )`,
            transform: `translateY(${Math.sin(frame * 0.7) * 1}px)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Product spotlight (soft dark gradient center for readability) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0.45) 0%, transparent 70%)`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
};
