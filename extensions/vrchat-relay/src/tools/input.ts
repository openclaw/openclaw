import { getOSCClient } from "../osc/client.js";

export interface SendInputParams {
  action:
    | "Jump"
    | "MoveForward"
    | "MoveBackward"
    | "MoveLeft"
    | "MoveRight"
    | "LookLeft"
    | "LookRight"
    | "LookUp"
    | "LookDown"
    | "Voice"
    | "Chat"
    | "Menu"
    | string;
  value?: boolean | number;
}

/**
 * Send input command to VRChat
 * Note: This requires PRO guard permission as it can control avatar movement
 */
export function sendInputCommand(params: SendInputParams): { success: boolean; error?: string } {
  try {
    const { action, value = true } = params;

    if (!action) {
      return { success: false, error: "Action cannot be empty" };
    }

    const client = getOSCClient();
    client.sendInput(action, value);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending input command",
    };
  }
}

// Valid input actions for VRChat
export const VALID_INPUT_ACTIONS = [
  "Jump",
  "MoveForward",
  "MoveBackward",
  "MoveLeft",
  "MoveRight",
  "LookLeft",
  "LookRight",
  "LookUp",
  "LookDown",
  "Voice",
  "Chat",
  "Menu",
  "Back",
  "Select",
  "Use",
  "Drop",
  "Grab",
  "Run",
  "Crouch",
  "Prone",
  "ToggleSit",
] as const;
