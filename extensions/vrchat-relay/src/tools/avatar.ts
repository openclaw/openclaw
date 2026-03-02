import { getOSCClient } from "../osc/client.js";

export interface SetAvatarParamParams {
  name: string;
  value: boolean | number;
}

/**
 * Set an avatar parameter in VRChat
 */
export function setAvatarParameter(params: SetAvatarParamParams): {
  success: boolean;
  error?: string;
} {
  try {
    const { name, value } = params;

    if (!name || name.trim() === "") {
      return { success: false, error: "Parameter name cannot be empty" };
    }

    if (typeof value !== "boolean" && typeof value !== "number") {
      return { success: false, error: "Value must be a boolean or number" };
    }

    const client = getOSCClient();
    client.sendAvatarParameter(name, value);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error setting avatar parameter",
    };
  }
}

export interface SendOSCParams {
  address: string;
  args: (string | number | boolean | null)[];
}

/**
 * Send a raw OSC message to VRChat
 */
export function sendOSCMessage(params: SendOSCParams): { success: boolean; error?: string } {
  try {
    const { address, args } = params;

    if (!address || !address.startsWith("/")) {
      return { success: false, error: "Address must start with /" };
    }

    const client = getOSCClient();
    client.send(address, args);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending OSC message",
    };
  }
}

export interface ChangeAvatarParams {
  avatarId: string;
}

/**
 * Change Avatar in VRChat via OSC (/avatar/change)
 */
export function changeAvatar(params: ChangeAvatarParams): { success: boolean; error?: string } {
  try {
    const { avatarId } = params;

    if (!avatarId || typeof avatarId !== "string" || !avatarId.startsWith("avtr_")) {
      return { success: false, error: "Invalid Avatar ID format. Must start with 'avtr_'" };
    }

    const client = getOSCClient();
    client.send("/avatar/change", [avatarId]);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error changing avatar",
    };
  }
}
