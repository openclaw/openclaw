// Permission Profiles for VRChat Control
// SAFE/PRO/DIRECTOR model for agent safety

export type PermissionLevel = "SAFE" | "PRO" | "DIRECTOR" | "ADMIN";

export interface PermissionProfile {
  level: PermissionLevel;
  description: string;
  allowedOperations: string[];
}

export const PERMISSION_PROFILES: Record<PermissionLevel, PermissionProfile> = {
  SAFE: {
    level: "SAFE",
    description: "Chat and avatar parameters only - no movement or camera",
    allowedOperations: [
      "chatbox_send",
      "chatbox_typing",
      "avatar_parameter_set",
      "avatar_parameter_get",
      "osc_send_safe",
    ],
  },
  PRO: {
    level: "PRO",
    description: "SAFE + input commands (jump, move, interact)",
    allowedOperations: [
      "chatbox_send",
      "chatbox_typing",
      "avatar_parameter_set",
      "avatar_parameter_get",
      "input_command",
      "osc_send_safe",
      "osc_send_input",
    ],
  },
  DIRECTOR: {
    level: "DIRECTOR",
    description: "SAFE + camera and dolly control for filming",
    allowedOperations: [
      "chatbox_send",
      "chatbox_typing",
      "avatar_parameter_set",
      "avatar_parameter_get",
      "camera_control",
      "dolly_control",
      "osc_send_safe",
      "osc_send_camera",
    ],
  },
  ADMIN: {
    level: "ADMIN",
    description: "All operations - human supervision required",
    allowedOperations: [
      "chatbox_send",
      "chatbox_typing",
      "avatar_parameter_set",
      "avatar_parameter_get",
      "input_command",
      "camera_control",
      "dolly_control",
      "osc_send_safe",
      "osc_send_input",
      "osc_send_camera",
      "permission_change",
    ],
  },
};

// Current active permission level
let currentPermissionLevel: PermissionLevel = "SAFE";
let permissionChangeTime: Date = new Date();

/**
 * Get current permission level
 */
export function getCurrentPermissionLevel(): PermissionLevel {
  return currentPermissionLevel;
}

/**
 * Set permission level with validation
 */
export function setPermissionLevel(level: PermissionLevel): {
  success: boolean;
  previousLevel: PermissionLevel;
  message: string;
} {
  const previousLevel = currentPermissionLevel;

  // Validate level
  if (!PERMISSION_PROFILES[level]) {
    return {
      success: false,
      previousLevel,
      message: `Invalid permission level: ${level}`,
    };
  }

  // Only allow escalation with explicit confirmation
  const levelOrder: PermissionLevel[] = ["SAFE", "PRO", "DIRECTOR", "ADMIN"];
  const currentIndex = levelOrder.indexOf(currentPermissionLevel);
  const newIndex = levelOrder.indexOf(level);

  if (newIndex > currentIndex) {
    // Escalating - add warning
    console.log(`[SECURITY] Permission escalation: ${previousLevel} -> ${level}`);
  }

  currentPermissionLevel = level;
  permissionChangeTime = new Date();

  return {
    success: true,
    previousLevel,
    message: `Permission level changed from ${previousLevel} to ${level}`,
  };
}

/**
 * Check if an operation is allowed
 */
export function isOperationAllowed(operation: string): boolean {
  const profile = PERMISSION_PROFILES[currentPermissionLevel];
  return profile.allowedOperations.includes(operation);
}

/**
 * Get allowed operations for current level
 */
export function getAllowedOperations(): string[] {
  return PERMISSION_PROFILES[currentPermissionLevel].allowedOperations;
}

/**
 * Get permission status
 */
export function getPermissionStatus(): {
  currentLevel: PermissionLevel;
  description: string;
  allowedOperations: string[];
  since: Date;
} {
  const profile = PERMISSION_PROFILES[currentPermissionLevel];
  return {
    currentLevel: currentPermissionLevel,
    description: profile.description,
    allowedOperations: profile.allowedOperations,
    since: permissionChangeTime,
  };
}

/**
 * Reset to SAFE mode (e.g., after timeout)
 */
export function resetToSafeMode(): void {
  if (currentPermissionLevel !== "SAFE") {
    console.log(`[SECURITY] Auto-reset to SAFE mode from ${currentPermissionLevel}`);
    currentPermissionLevel = "SAFE";
    permissionChangeTime = new Date();
  }
}

/**
 * Permission check with automatic blocking
 */
export function checkPermission(operation: string): {
  allowed: boolean;
  level: PermissionLevel;
  message?: string;
} {
  if (!isOperationAllowed(operation)) {
    return {
      allowed: false,
      level: currentPermissionLevel,
      message:
        `Operation '${operation}' not allowed at ${currentPermissionLevel} level. ` +
        `Requires: ${getRequiredLevel(operation)}`,
    };
  }

  return {
    allowed: true,
    level: currentPermissionLevel,
  };
}

function getRequiredLevel(operation: string): string {
  for (const [level, profile] of Object.entries(PERMISSION_PROFILES)) {
    if (profile.allowedOperations.includes(operation)) {
      return level;
    }
  }
  return "ADMIN";
}
