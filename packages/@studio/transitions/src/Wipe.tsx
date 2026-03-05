import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import type { WipeProps } from "./types";

/**
 * Wipe In transition component
 */
export const WipeIn: React.FC<WipeProps> = ({
  children,
  startFrame,
  duration,
  direction = "right",
}) => {
  const frame = useCurrentFrame();

  const progress = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 100],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const getClipPath = () => {
    switch (direction) {
      case "right":
        return `inset(0 ${100 - progress}% 0 0)`;
      case "left":
        return `inset(0 0 0 ${100 - progress}%)`;
      case "down":
        return `inset(0 0 ${100 - progress}% 0)`;
      case "up":
        return `inset(${100 - progress}% 0 0 0)`;
      default:
        return "none";
    }
  };

  return <div style={{ clipPath: getClipPath() }}>{children}</div>;
};

/**
 * Wipe Out transition component
 */
export const WipeOut: React.FC<WipeProps> = ({
  children,
  startFrame,
  duration,
  direction = "left",
}) => {
  const frame = useCurrentFrame();

  const progress = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 100],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const getClipPath = () => {
    switch (direction) {
      case "left":
        return `inset(0 ${progress}% 0 0)`;
      case "right":
        return `inset(0 0 0 ${progress}%)`;
      case "up":
        return `inset(0 0 ${progress}% 0)`;
      case "down":
        return `inset(${progress}% 0 0 0)`;
      default:
        return "none";
    }
  };

  return <div style={{ clipPath: getClipPath() }}>{children}</div>;
};

/**
 * Generic Wipe transition (in or out)
 */
export const Wipe: React.FC<WipeProps & { type?: "in" | "out" }> = ({
  children,
  startFrame,
  duration,
  direction = "right",
  type = "in",
}) => {
  if (type === "out") {
    return (
      <WipeOut
        startFrame={startFrame}
        duration={duration}
        direction={direction}
      >
        {children}
      </WipeOut>
    );
  }

  return (
    <WipeIn startFrame={startFrame} duration={duration} direction={direction}>
      {children}
    </WipeIn>
  );
};
