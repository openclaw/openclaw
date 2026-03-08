import {
  clampCameraValue,
  isValidCameraParameter,
  getCameraOSCAddress,
  CAMERA_TOGGLE_PARAMETERS,
} from "../osc/camera.js";
import { getOSCClient } from "../osc/client.js";
import { logInfo, logSkip, logError } from "./audit.js";
import { checkPermission } from "./permissions.js";
import { rateLimiters } from "./rate-limiter.js";

export interface CameraSetParams {
  parameter: string;
  value: number | boolean;
}

export interface CameraHSLParams {
  hue?: number;
  saturation?: number;
  lightness?: number;
}

export interface CameraLookAtMeParams {
  xOffset?: number;
  yOffset?: number;
  enabled?: boolean;
}

/**
 * Set a camera parameter with validation and rate limiting
 */
export function setCameraParameter(params: CameraSetParams): {
  success: boolean;
  error?: string;
  clamped?: boolean;
} {
  const permission = checkPermission("camera_control");

  if (!permission.allowed) {
    logSkip("camera_control", permission.message || "Permission denied", {
      parameter: params.parameter,
      level: permission.level,
    });
    return { success: false, error: permission.message };
  }

  // Check rate limit
  const rateLimit = rateLimiters.camera.allowAction();
  if (!rateLimit.allowed) {
    const error = rateLimit.jailTimeRemaining
      ? `Rate limit exceeded. Jail time: ${Math.ceil(rateLimit.jailTimeRemaining / 1000)}s`
      : "Rate limit exceeded";

    logSkip("camera_control", error, { parameter: params.parameter });
    return { success: false, error };
  }

  try {
    const { parameter, value } = params;

    // Validate parameter
    if (!isValidCameraParameter(parameter)) {
      logSkip("camera_control", `Invalid camera parameter: ${parameter}`);
      return { success: false, error: `Invalid camera parameter: ${parameter}` };
    }

    const client = getOSCClient();
    const address = getCameraOSCAddress(parameter);

    if (!address) {
      return { success: false, error: `Unknown camera parameter: ${parameter}` };
    }

    // Handle boolean toggles
    if (CAMERA_TOGGLE_PARAMETERS.includes(parameter)) {
      const boolValue = Boolean(value);
      client.send(address, [boolValue]);

      logInfo("camera_control", {
        parameter,
        value: boolValue,
        address,
        remaining: rateLimit.remaining,
      });

      return { success: true };
    }

    // Handle numeric parameters with clamping
    const numValue = typeof value === "number" ? value : Number(value);
    const clampedValue = clampCameraValue(parameter, numValue);
    const wasClamped = clampedValue !== numValue;

    client.send(address, [clampedValue]);

    logInfo("camera_control", {
      parameter,
      value: clampedValue,
      wasClamped,
      address,
      remaining: rateLimit.remaining,
    });

    return {
      success: true,
      clamped: wasClamped,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("camera_control", errorMessage, { parameter: params.parameter });
    return { success: false, error: errorMessage };
  }
}

/**
 * Set GreenScreen HSL values
 */
export function setGreenScreenHSL(params: CameraHSLParams): { success: boolean; error?: string } {
  const permission = checkPermission("camera_control");

  if (!permission.allowed) {
    logSkip("greenscreen_hsl", permission.message || "Permission denied");
    return { success: false, error: permission.message };
  }

  try {
    const client = getOSCClient();

    // Step 1: Enable GreenScreen
    client.send("/usercamera/GreenScreen", [true]);

    // Step 2: Set HSL values if provided
    if (params.hue !== undefined) {
      const clampedHue = clampCameraValue("Hue", params.hue);
      client.send("/usercamera/Hue", [clampedHue]);
    }

    if (params.saturation !== undefined) {
      const clampedSat = clampCameraValue("Saturation", params.saturation);
      client.send("/usercamera/Saturation", [clampedSat]);
    }

    if (params.lightness !== undefined) {
      // Lightness max is 50 per spec, despite default showing 60
      const clampedLight = Math.min(50, Math.max(0, params.lightness));
      client.send("/usercamera/Lightness", [clampedLight]);
    }

    logInfo("greenscreen_hsl", {
      hue: params.hue,
      saturation: params.saturation,
      lightness: params.lightness,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("greenscreen_hsl", errorMessage, { ...params });
    return { success: false, error: errorMessage };
  }
}

/**
 * Set LookAtMe with offsets
 */
export function setLookAtMeComposition(params: CameraLookAtMeParams): {
  success: boolean;
  error?: string;
} {
  const permission = checkPermission("camera_control");

  if (!permission.allowed) {
    logSkip("lookatme_composition", permission.message || "Permission denied");
    return { success: false, error: permission.message };
  }

  try {
    const client = getOSCClient();

    // Enable LookAtMe if requested
    if (params.enabled !== undefined) {
      client.send("/usercamera/LookAtMe", [params.enabled]);
    }

    // Set offsets
    if (params.xOffset !== undefined) {
      const clampedX = clampCameraValue("LookAtMeXOffset", params.xOffset);
      client.send("/usercamera/LookAtMeXOffset", [clampedX]);
    }

    if (params.yOffset !== undefined) {
      const clampedY = clampCameraValue("LookAtMeYOffset", params.yOffset);
      client.send("/usercamera/LookAtMeYOffset", [clampedY]);
    }

    logInfo("lookatme_composition", {
      enabled: params.enabled,
      xOffset: params.xOffset,
      yOffset: params.yOffset,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("lookatme_composition", errorMessage, { ...params });
    return { success: false, error: errorMessage };
  }
}

/**
 * Set smoothing with automatic toggle
 */
export function setCameraSmoothing(strength: number): { success: boolean; error?: string } {
  const permission = checkPermission("camera_control");

  if (!permission.allowed) {
    logSkip("camera_smoothing", permission.message || "Permission denied");
    return { success: false, error: permission.message };
  }

  try {
    const client = getOSCClient();
    const clampedStrength = clampCameraValue("SmoothingStrength", strength);

    // Enable SmoothMovement first, then set strength
    client.send("/usercamera/SmoothMovement", [true]);
    client.send("/usercamera/SmoothingStrength", [clampedStrength]);

    logInfo("camera_smoothing", { strength: clampedStrength });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("camera_smoothing", errorMessage, { strength });
    return { success: false, error: errorMessage };
  }
}

/**
 * Trigger camera capture
 */
export function captureCamera(delayed: boolean = false): { success: boolean; error?: string } {
  const permission = checkPermission("camera_control");

  if (!permission.allowed) {
    logSkip("camera_capture", permission.message || "Permission denied");
    return { success: false, error: permission.message };
  }

  try {
    const client = getOSCClient();
    const address = delayed ? "/usercamera/CaptureDelayed" : "/usercamera/Capture";

    client.send(address, [true]);

    logInfo("camera_capture", { delayed });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("camera_capture", errorMessage, { delayed });
    return { success: false, error: errorMessage };
  }
}

/**
 * Get camera rate limit status
 */
export function getCameraRateLimitStatus(): {
  allowed: boolean;
  remaining: number;
  inJail: boolean;
  jailTimeRemaining: number;
} {
  const status = rateLimiters.camera.getStatus();
  return {
    allowed: !status.inJail && status.tokens > 0,
    remaining: status.tokens,
    inJail: status.inJail,
    jailTimeRemaining: status.jailTimeRemaining,
  };
}
