/**
 * Composition metadata
 */
export interface CompositionMetadata {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

/**
 * Composition input props (generic)
 */
export interface CompositionProps<T = unknown> {
  inputProps?: T;
}

/**
 * Common text composition props
 */
export interface TextCompositionProps {
  title?: string;
  subtitle?: string;
  body?: string;
}

/**
 * Common media composition props
 */
export interface MediaCompositionProps {
  imageSrc?: string;
  videoSrc?: string;
  audioSrc?: string;
}
