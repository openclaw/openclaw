import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import type { TransitionProps } from "./types";

/**
 * Fade In transition component
 */
export const FadeIn: React.FC<TransitionProps> = ({
  children,
  startFrame,
  duration,
}) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return <div style={{ opacity }}>{children}</div>;
};

/**
 * Fade Out transition component
 */
export const FadeOut: React.FC<TransitionProps> = ({
  children,
  startFrame,
  duration,
}) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return <div style={{ opacity }}>{children}</div>;
};

/**
 * Generic Fade transition (in or out)
 */
export const Fade: React.FC<TransitionProps> = ({
  children,
  startFrame,
  duration,
  type = "in",
}) => {
  if (type === "out") {
    return (
      <FadeOut startFrame={startFrame} duration={duration}>
        {children}
      </FadeOut>
    );
  }

  return (
    <FadeIn startFrame={startFrame} duration={duration}>
      {children}
    </FadeIn>
  );
};
