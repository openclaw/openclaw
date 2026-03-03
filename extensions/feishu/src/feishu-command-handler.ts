import type { PluginHookRunner } from "openclaw/plugin-sdk";
import { DEFAULT_RESET_TRIGGERS } from "../../../config/sessions/types.js";

/**
 * Handle Feishu command messages and trigger appropriate hooks
 */
export async function handleFeishuCommand(
  messageText: string,
  sessionKey: string,
  hookRunner: PluginHookRunner,
  context: {
    cfg: any;
    sessionEntry: any;
    previousSessionEntry?: any;
    commandSource: string;
    timestamp: number;
  }
): Promise<boolean> {
  // Check if message is a reset command
  const trimmed = messageText.trim().toLowerCase();
  const isResetCommand = DEFAULT_RESET_TRIGGERS.some(trigger => 
    trimmed === trigger || trimmed.startsWith(`${trigger} `)
  );

  if (isResetCommand) {
    // Extract the actual command (without arguments)
    const command = trimmed.split(' ')[0];
    
    // Trigger the before_reset hook
    await hookRunner.runBeforeReset(
      {
        type: "command",
        action: command.replace('/', '') as "new" | "reset",
        context: {
          ...context,
          commandSource: "feishu"
        }
      },
      {
        agentId: "main", // or extract from sessionKey
        sessionKey
      }
    );
    
    return true; // Command was handled
  }
  
  return false; // Not a command we handle
}