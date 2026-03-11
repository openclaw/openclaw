import * as pilotctl from "./pilotctl.js";
import type { PilotPeer, PilotTrustRequest } from "./types.js";

type TrustOptions = {
  socketPath?: string;
  pilotctlPath?: string;
};

export async function handshake(addr: string, opts?: TrustOptions): Promise<{ status: string }> {
  return pilotctl.trustHandshake(addr, opts);
}

export async function approve(addr: string, opts?: TrustOptions): Promise<{ status: string }> {
  return pilotctl.trustApprove(addr, opts);
}

export async function reject(addr: string, opts?: TrustOptions): Promise<{ status: string }> {
  return pilotctl.trustReject(addr, opts);
}

export async function listTrusted(opts?: TrustOptions): Promise<PilotPeer[]> {
  return pilotctl.trustList(opts);
}

export async function listPending(opts?: TrustOptions): Promise<PilotTrustRequest[]> {
  return pilotctl.trustPending(opts);
}
