import crypto from "node:crypto";

const LAUNCH_TICKET_TTL_MS = 5 * 60_000;
const LAUNCH_TICKET_LIMIT = 1000;

type LaunchTicket = {
  accountId: string;
  userId: string;
  expiresAtMs: number;
};

// A ticket proves the Mini App launch came from the owner-only /dashboard command.
// Binding and single-use consumption prevent reuse across accounts or Telegram owners.
const launchTickets = new Map<string, LaunchTicket>();

export function issueTelegramMiniAppLaunchTicket(params: {
  accountId: string;
  userId: string;
}): string {
  pruneLaunchTickets();
  const ticket = crypto.randomBytes(32).toString("base64url");
  launchTickets.set(ticket, {
    accountId: params.accountId,
    userId: params.userId,
    expiresAtMs: Date.now() + LAUNCH_TICKET_TTL_MS,
  });
  while (launchTickets.size > LAUNCH_TICKET_LIMIT) {
    const oldest = launchTickets.keys().next().value;
    if (!oldest) {
      break;
    }
    launchTickets.delete(oldest);
  }
  return ticket;
}

export function consumeTelegramMiniAppLaunchTicket(params: {
  ticket: string;
  accountId: string;
  userId: string;
}): boolean {
  pruneLaunchTickets();
  const launch = launchTickets.get(params.ticket);
  if (!launch || launch.accountId !== params.accountId || launch.userId !== params.userId) {
    return false;
  }
  launchTickets.delete(params.ticket);
  return true;
}

function pruneLaunchTickets(): void {
  const now = Date.now();
  for (const [ticket, launch] of launchTickets) {
    if (launch.expiresAtMs <= now) {
      launchTickets.delete(ticket);
    }
  }
}
