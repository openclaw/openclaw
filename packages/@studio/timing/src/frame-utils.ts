/**
 * Convert seconds to frames
 * @param seconds - Time in seconds
 * @param fps - Frames per second
 * @returns Number of frames
 */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * Convert frames to seconds
 * @param frames - Number of frames
 * @param fps - Frames per second
 * @returns Time in seconds
 */
export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/**
 * Get frame number from time in milliseconds
 * @param timeMs - Time in milliseconds
 * @param fps - Frames per second
 * @returns Frame number
 */
export function msToFrame(timeMs: number, fps: number): number {
  return Math.round((timeMs / 1000) * fps);
}

/**
 * Get time in milliseconds from frame number
 * @param frame - Frame number
 * @param fps - Frames per second
 * @returns Time in milliseconds
 */
export function frameToMs(frame: number, fps: number): number {
  return (frame / fps) * 1000;
}

/**
 * Clamp a frame number within a valid range
 * @param frame - Current frame
 * @param min - Minimum frame (default: 0)
 * @param max - Maximum frame
 * @returns Clamped frame number
 */
export function clampFrame(
  frame: number,
  min: number = 0,
  max: number,
): number {
  return Math.max(min, Math.min(max, frame));
}

/**
 * Calculate progress (0-1) within a frame range
 * @param frame - Current frame
 * @param start - Start frame
 * @param end - End frame
 * @returns Progress value between 0 and 1
 */
export function getProgress(frame: number, start: number, end: number): number {
  if (frame <= start) return 0;
  if (frame >= end) return 1;
  return (frame - start) / (end - start);
}
