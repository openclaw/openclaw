import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import React from "react";

const Cat: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  // Body bounce
  const bounce = interpolate(Math.sin(frame * 0.3), [-1, 1], [-15, 15]);
  // Side sway
  const sway = interpolate(Math.sin(frame * 0.2), [-1, 1], [-10, 10]);
  // Rotation tilt
  const tilt = interpolate(Math.sin(frame * 0.25), [-1, 1], [-8, 8]);

  // Arm wave (left)
  const leftArmAngle = interpolate(Math.sin(frame * 0.4), [-1, 1], [-45, 30]);
  // Arm wave (right) — offset phase
  const rightArmAngle = interpolate(
    Math.sin(frame * 0.4 + Math.PI),
    [-1, 1],
    [-45, 30],
  );

  // Leg kick
  const leftLegAngle = interpolate(
    Math.sin(frame * 0.35),
    [-1, 1],
    [-15, 15],
  );
  const rightLegAngle = interpolate(
    Math.sin(frame * 0.35 + Math.PI),
    [-1, 1],
    [-15, 15],
  );

  // Tail wag
  const tailWag = interpolate(Math.sin(frame * 0.5), [-1, 1], [-30, 30]);

  // Eye blink
  const blinkCycle = frame % 90;
  const eyeScaleY = blinkCycle < 3 ? 0.1 : 1;

  // Ear wiggle
  const earWiggle = interpolate(Math.sin(frame * 0.6), [-1, 1], [-5, 5]);

  return (
    <g
      transform={`translate(${640 + sway}, ${330 + bounce}) rotate(${tilt})`}
    >
      {/* Tail */}
      <g transform={`translate(-55, 30) rotate(${tailWag}, 0, 0)`}>
        <path
          d="M0,0 Q-40,-60 -20,-100"
          stroke="#FF8C42"
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
        />
      </g>

      {/* Left leg */}
      <g transform={`translate(-30, 70) rotate(${leftLegAngle}, 0, 0)`}>
        <rect
          x="-8"
          y="0"
          width="16"
          height="50"
          rx="8"
          fill="#FF8C42"
        />
        <ellipse cx="0" cy="50" rx="12" ry="8" fill="#E07030" />
      </g>

      {/* Right leg */}
      <g transform={`translate(30, 70) rotate(${rightLegAngle}, 0, 0)`}>
        <rect
          x="-8"
          y="0"
          width="16"
          height="50"
          rx="8"
          fill="#FF8C42"
        />
        <ellipse cx="0" cy="50" rx="12" ry="8" fill="#E07030" />
      </g>

      {/* Body */}
      <ellipse cx="0" cy="30" rx="55" ry="60" fill="#FF8C42" />
      {/* Belly */}
      <ellipse cx="0" cy="40" rx="35" ry="40" fill="#FFD4A8" />

      {/* Left arm */}
      <g transform={`translate(-50, 0) rotate(${leftArmAngle}, 8, 0)`}>
        <rect
          x="0"
          y="0"
          width="16"
          height="45"
          rx="8"
          fill="#FF8C42"
        />
        <ellipse cx="8" cy="45" rx="10" ry="7" fill="#E07030" />
      </g>

      {/* Right arm */}
      <g transform={`translate(34, 0) rotate(${rightArmAngle}, 8, 0)`}>
        <rect
          x="0"
          y="0"
          width="16"
          height="45"
          rx="8"
          fill="#FF8C42"
        />
        <ellipse cx="8" cy="45" rx="10" ry="7" fill="#E07030" />
      </g>

      {/* Head */}
      <g transform="translate(0, -50)">
        {/* Head shape */}
        <circle cx="0" cy="0" r="45" fill="#FF8C42" />

        {/* Left ear */}
        <g transform={`rotate(${earWiggle}, -25, -35)`}>
          <polygon points="-40,-25 -25,-55 -10,-25" fill="#FF8C42" />
          <polygon points="-36,-28 -25,-48 -14,-28" fill="#FFB8D0" />
        </g>

        {/* Right ear */}
        <g transform={`rotate(${-earWiggle}, 25, -35)`}>
          <polygon points="10,-25 25,-55 40,-25" fill="#FF8C42" />
          <polygon points="14,-28 25,-48 36,-28" fill="#FFB8D0" />
        </g>

        {/* Face */}
        <circle cx="0" cy="5" r="32" fill="#FFD4A8" />

        {/* Eyes */}
        <g transform={`translate(-14, -5) scale(1, ${eyeScaleY})`}>
          <ellipse cx="0" cy="0" rx="8" ry="9" fill="white" />
          <circle cx="2" cy="1" r="5" fill="#2D2D2D" />
          <circle cx="4" cy="-1" r="2" fill="white" />
        </g>
        <g transform={`translate(14, -5) scale(1, ${eyeScaleY})`}>
          <ellipse cx="0" cy="0" rx="8" ry="9" fill="white" />
          <circle cx="2" cy="1" r="5" fill="#2D2D2D" />
          <circle cx="4" cy="-1" r="2" fill="white" />
        </g>

        {/* Nose */}
        <polygon points="0,5 -4,9 4,9" fill="#FF6B8A" />

        {/* Mouth */}
        <path
          d="M-8,12 Q0,20 8,12"
          stroke="#2D2D2D"
          strokeWidth="2"
          fill="none"
        />

        {/* Whiskers */}
        <line
          x1="-15"
          y1="10"
          x2="-45"
          y2="5"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
        <line
          x1="-15"
          y1="14"
          x2="-45"
          y2="14"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
        <line
          x1="-15"
          y1="18"
          x2="-45"
          y2="23"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
        <line
          x1="15"
          y1="10"
          x2="45"
          y2="5"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
        <line
          x1="15"
          y1="14"
          x2="45"
          y2="14"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
        <line
          x1="15"
          y1="18"
          x2="45"
          y2="23"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
      </g>
    </g>
  );
};

const DiscoFloor: React.FC<{ frame: number }> = ({ frame }) => {
  const colors = ["#FF006E", "#8338EC", "#3A86FF", "#FFBE0B", "#FB5607"];
  const tiles: React.ReactNode[] = [];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      const colorIndex = (row + col + Math.floor(frame / 6)) % colors.length;
      const brightness = interpolate(
        Math.sin(frame * 0.15 + row * 1.2 + col * 0.8),
        [-1, 1],
        [0.6, 1],
      );
      tiles.push(
        <rect
          key={`${row}-${col}`}
          x={col * 160}
          y={520 + row * 50}
          width="160"
          height="50"
          fill={colors[colorIndex]}
          opacity={brightness}
        />,
      );
    }
  }

  return <>{tiles}</>;
};

const DiscoBall: React.FC<{ frame: number }> = ({ frame }) => {
  const rotate = frame * 3;
  const swingX = interpolate(Math.sin(frame * 0.08), [-1, 1], [-20, 20]);

  const sparkles: React.ReactNode[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (frame * 2 + i * 45) * (Math.PI / 180);
    const dist = 60 + Math.sin(frame * 0.2 + i) * 20;
    sparkles.push(
      <circle
        key={i}
        cx={640 + swingX + Math.cos(angle) * dist}
        cy={80 + Math.sin(angle) * dist}
        r={3}
        fill="white"
        opacity={interpolate(
          Math.sin(frame * 0.3 + i),
          [-1, 1],
          [0.2, 1],
        )}
      />,
    );
  }

  return (
    <g>
      {/* String */}
      <line
        x1={640 + swingX}
        y1={0}
        x2={640 + swingX}
        y2={55}
        stroke="#888"
        strokeWidth="2"
      />
      {/* Ball */}
      <circle
        cx={640 + swingX}
        cy={80}
        r="30"
        fill="url(#discoBallGradient)"
        stroke="#ccc"
        strokeWidth="1"
      />
      {/* Facets */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect
          key={i}
          x={640 + swingX - 8}
          y={80 - 8}
          width="16"
          height="8"
          fill="white"
          opacity={0.4}
          transform={`rotate(${rotate + i * 60}, ${640 + swingX}, 80)`}
        />
      ))}
      {/* Sparkles */}
      {sparkles}
    </g>
  );
};

const MusicNotes: React.FC<{ frame: number }> = ({ frame }) => {
  const notes = ["♪", "♫", "♩", "♬"];
  return (
    <>
      {notes.map((note, i) => {
        const x = 200 + i * 250;
        const baseY = 300;
        const yOffset = interpolate(
          (frame + i * 20) % 60,
          [0, 60],
          [0, -150],
        );
        const opacity = interpolate(
          (frame + i * 20) % 60,
          [0, 40, 60],
          [1, 1, 0],
        );
        const xWobble = Math.sin((frame + i * 15) * 0.1) * 20;

        return (
          <text
            key={i}
            x={x + xWobble}
            y={baseY + yOffset}
            fontSize="40"
            fill="white"
            opacity={opacity}
            textAnchor="middle"
            fontFamily="serif"
          >
            {note}
          </text>
        );
      })}
    </>
  );
};

const SpotLights: React.FC<{ frame: number }> = ({ frame }) => {
  const leftAngle = interpolate(
    Math.sin(frame * 0.1),
    [-1, 1],
    [-20, 20],
  );
  const rightAngle = interpolate(
    Math.sin(frame * 0.1 + 2),
    [-1, 1],
    [-20, 20],
  );

  return (
    <g opacity={0.15}>
      <polygon
        points={`200,0 ${300 + leftAngle * 5},720 ${100 + leftAngle * 5},720`}
        fill="#FF006E"
      />
      <polygon
        points={`1080,0 ${1180 + rightAngle * 5},720 ${980 + rightAngle * 5},720`}
        fill="#3A86FF"
      />
    </g>
  );
};

export const MyComposition = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Intro: cat bounces in
  const introProgress = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });
  const catScale = interpolate(introProgress, [0, 1], [0, 1]);

  // Background color pulse
  const bgLightness = interpolate(
    Math.sin(frame * 0.1),
    [-1, 1],
    [8, 18],
  );

  // Title
  const titleOpacity = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [0, 15], [50, 30], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <svg
        viewBox="0 0 1280 720"
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <defs>
          <radialGradient id="discoBallGradient" cx="40%" cy="35%">
            <stop offset="0%" stopColor="#eee" />
            <stop offset="100%" stopColor="#888" />
          </radialGradient>
          <radialGradient id="bgGlow" cx="50%" cy="50%">
            <stop
              offset="0%"
              stopColor={`hsl(270, 50%, ${bgLightness + 10}%)`}
            />
            <stop
              offset="100%"
              stopColor={`hsl(270, 60%, ${bgLightness}%)`}
            />
          </radialGradient>
        </defs>

        {/* Background */}
        <rect width="1280" height="720" fill="url(#bgGlow)" />

        {/* Spotlights */}
        <SpotLights frame={frame} />

        {/* Disco floor */}
        <DiscoFloor frame={frame} />

        {/* Disco ball */}
        <DiscoBall frame={frame} />

        {/* Music notes */}
        <MusicNotes frame={frame} />

        {/* Dancing cat */}
        <g
          transform={`translate(0, 0) scale(${catScale})`}
          style={{ transformOrigin: "640px 360px" }}
        >
          <Cat frame={frame} fps={fps} />
        </g>

        {/* Title text */}
        <text
          x="640"
          y={titleY}
          textAnchor="middle"
          fontSize="48"
          fontWeight="bold"
          fill="white"
          opacity={titleOpacity}
          fontFamily="sans-serif"
          style={{
            textShadow: "0 2px 10px rgba(0,0,0,0.5)",
          }}
        >
          🐱 Dance Cat Dance! 🐱
        </text>
      </svg>
    </div>
  );
};
