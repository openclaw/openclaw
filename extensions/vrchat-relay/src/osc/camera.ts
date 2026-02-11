// VRChat Camera OSC Parameters - Based on VRChat 2025.3.3 Open Beta specs
// Reference: https://docs.vrchat.com/docs/vrchat-202533-openbeta

export interface CameraParameterRange {
  min: number;
  max: number;
  type: "float" | "bool" | "int";
}

// Official camera parameter ranges from VRChat documentation
export const CAMERA_PARAMETERS: Record<string, CameraParameterRange> = {
  // Zoom and Focus
  Zoom: { min: 20, max: 150, type: "float" },
  Aperture: { min: 1.4, max: 32, type: "float" },
  FocalDistance: { min: 0, max: 10, type: "float" },

  // Exposure and Timing
  Exposure: { min: 0, max: 10, type: "float" },
  PhotoRate: { min: 0.1, max: 2, type: "float" },
  Duration: { min: 0.1, max: 60, type: "float" },

  // Movement Speed
  FlySpeed: { min: 0.1, max: 15, type: "float" },
  TurnSpeed: { min: 0.1, max: 5, type: "float" },

  // Smoothing (Strength only, handled separately)
  SmoothingStrength: { min: 0.1, max: 10, type: "float" },

  // GreenScreen Color (HSL)
  Hue: { min: 0, max: 360, type: "float" },
  Saturation: { min: 0, max: 100, type: "float" },
  Lightness: { min: 0, max: 50, type: "float" },

  // LookAtMe Offsets
  LookAtMeXOffset: { min: -25, max: 25, type: "float" },
  LookAtMeYOffset: { min: -25, max: 25, type: "float" },
};

// Boolean toggle parameters
export const CAMERA_TOGGLE_PARAMETERS = ["SmoothMovement", "LookAtMe", "GreenScreen"];

// All valid camera OSC addresses
export const CAMERA_OSC_ADDRESSES = {
  zoom: "/usercamera/Zoom",
  aperture: "/usercamera/Aperture",
  focalDistance: "/usercamera/FocalDistance",
  exposure: "/usercamera/Exposure",
  photoRate: "/usercamera/PhotoRate",
  duration: "/usercamera/Duration",
  flySpeed: "/usercamera/FlySpeed",
  turnSpeed: "/usercamera/TurnSpeed",
  smoothMovement: "/usercamera/SmoothMovement",
  smoothingStrength: "/usercamera/SmoothingStrength",
  lookAtMe: "/usercamera/LookAtMe",
  lookAtMeXOffset: "/usercamera/LookAtMeXOffset",
  lookAtMeYOffset: "/usercamera/LookAtMeYOffset",
  greenScreen: "/usercamera/GreenScreen",
  hue: "/usercamera/Hue",
  saturation: "/usercamera/Saturation",
  lightness: "/usercamera/Lightness",
  capture: "/usercamera/Capture",
  captureDelayed: "/usercamera/CaptureDelayed",
} as const;

/**
 * Clamp a value to the valid range for a camera parameter
 */
export function clampCameraValue(param: string, value: number): number {
  const range = CAMERA_PARAMETERS[param];
  if (!range) return value;

  return Math.max(range.min, Math.min(range.max, value));
}

/**
 * Validate if a camera parameter exists
 */
export function isValidCameraParameter(param: string): boolean {
  return param in CAMERA_PARAMETERS || CAMERA_TOGGLE_PARAMETERS.includes(param);
}

/**
 * Get the OSC address for a camera parameter
 */
export function getCameraOSCAddress(param: string): string | null {
  const key = param.toLowerCase();
  const entry = Object.entries(CAMERA_OSC_ADDRESSES).find(([k]) => k.toLowerCase() === key);
  return entry ? entry[1] : null;
}
