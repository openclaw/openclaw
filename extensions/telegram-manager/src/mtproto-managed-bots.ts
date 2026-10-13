// Managed-bots MTProto surface (Layer 225).
// Real methods: bots.checkUsername, bots.createBot, bots.exportBotToken
// (revoke flag rotates), bots.getAdminedBots, bots.getAccessSettings,
// bots.editAccessSettings. There is NO bots.updateBot / bots.getBotToken /
// bots.resetBotToken — use bots.setBotInfo-family and exportBotToken instead.

export const BOT_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;

export function validateBotUsername(username: string): { valid: boolean; reason?: string } {
  const name = username.trim().replace(/^@/, "");
  if (!BOT_USERNAME_PATTERN.test(name)) {
    return { valid: false, reason: "Username must be 5-32 chars of [A-Za-z0-9_]" };
  }
  if (!name.toLowerCase().endsWith("bot")) {
    return { valid: false, reason: "USERNAME_SUFFIX_MISSING: username must end in 'bot'" };
  }
  return { valid: true };
}

export function validateBotName(name: string): { valid: boolean; reason?: string } {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    return { valid: false, reason: "NAME_INVALID: display name must be 1-64 chars" };
  }
  return { valid: true };
}

export type ManagedBotErrorCode =
  | "USERNAME_INVALID"
  | "USERNAME_OCCUPIED"
  | "USERNAME_SUFFIX_MISSING"
  | "NAME_INVALID"
  | "BOT_CREATE_LIMIT_EXCEEDED"
  | "MANAGER_INVALID"
  | "MANAGER_PERMISSION_MISSING"
  | "USER_BOT_REQUIRED"
  | "BOT_INVALID"
  | "FLOOD_WAIT"
  | "UNKNOWN";

export function classifyManagedBotError(message: string): ManagedBotErrorCode {
  const m = message.toUpperCase();
  if (m.includes("USERNAME_OCCUPIED")) {
    return "USERNAME_OCCUPIED";
  }
  if (m.includes("USERNAME_SUFFIX_MISSING")) {
    return "USERNAME_SUFFIX_MISSING";
  }
  if (m.includes("USERNAME_INVALID")) {
    return "USERNAME_INVALID";
  }
  if (m.includes("NAME_INVALID")) {
    return "NAME_INVALID";
  }
  if (m.includes("BOT_CREATE_LIMIT_EXCEEDED")) {
    return "BOT_CREATE_LIMIT_EXCEEDED";
  }
  if (m.includes("MANAGER_PERMISSION_MISSING")) {
    return "MANAGER_PERMISSION_MISSING";
  }
  if (m.includes("MANAGER_INVALID")) {
    return "MANAGER_INVALID";
  }
  if (m.includes("USER_BOT_REQUIRED")) {
    return "USER_BOT_REQUIRED";
  }
  if (m.includes("BOT_INVALID")) {
    return "BOT_INVALID";
  }
  if (m.includes("FLOOD_WAIT")) {
    return "FLOOD_WAIT";
  }
  return "UNKNOWN";
}

// Split-session contract: bots.createBot runs on a USER session,
// bots.exportBotToken runs on the MANAGER-BOT session.
export type ManagedBotCreator = {
  checkUsername(username: string): Promise<boolean>;
  createBot(params: { name: string; username: string }): Promise<{ botId: string }>;
};

export type ManagedBotTokenExporter = {
  exportBotToken(params: { botId: string; revoke: boolean }): Promise<{ token: string }>;
};

export async function createManagedBotWithToken(params: {
  creator: ManagedBotCreator;
  exporter: ManagedBotTokenExporter;
  name: string;
  username: string;
}): Promise<{ botId: string; token: string }> {
  const cleanUsername = params.username.trim().replace(/^@/, "");
  const nameCheck = validateBotName(params.name);
  if (!nameCheck.valid) {
    throw new Error(nameCheck.reason);
  }
  const userCheck = validateBotUsername(cleanUsername);
  if (!userCheck.valid) {
    throw new Error(userCheck.reason);
  }
  const available = await params.creator.checkUsername(cleanUsername);
  if (!available) {
    throw new Error("USERNAME_OCCUPIED");
  }
  const created = await params.creator.createBot({
    name: params.name.trim(),
    username: cleanUsername,
  });
  const exported = await params.exporter.exportBotToken({ botId: created.botId, revoke: false });
  if (!exported.token.includes(":")) {
    throw new Error("BOT_INVALID: exported token shape invalid");
  }
  return { botId: created.botId, token: exported.token };
}
