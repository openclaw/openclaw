import type { ReactNode } from "react";

/**
 * Base transition props
 */
export interface TransitionProps {
  children: ReactNode;
  /** Start frame of the transition */
  startFrame: number;
  /** Duration of the transition in frames */
  duration: number;
  /** Type of transition (in or out) */
  type?: "in" | "out";
}

/**
 * Direction for directional transitions
 */
export type Direction = "up" | "down" | "left" | "right";

/**
 * Slide transition props
 */
export interface SlideProps extends TransitionProps {
  /** Direction of the slide */
  direction?: Direction;
  /** Distance to slide (in pixels or percentage) */
  distance?: number;
}

/**
 * Wipe transition props
 */
export interface WipeProps extends TransitionProps {
  /** Direction of the wipe */
  direction?: Direction;
}
