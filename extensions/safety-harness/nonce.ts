import { randomInt } from "node:crypto";

export function generateNonce(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type NonceChallengeData = {
  tool: string;
  params: Record<string, unknown>;
};

export class NonceChallenge {
  public readonly nonce: string;
  public readonly tool: string;
  public readonly params: Record<string, unknown>;
  public readonly expiresAt: number;

  constructor(tool: string, params: Record<string, unknown>, ttlMs: number) {
    this.nonce = generateNonce();
    this.tool = tool;
    this.params = params;
    this.expiresAt = Date.now() + ttlMs;
  }

  verify(nonce: string): boolean {
    if (nonce !== this.nonce) return false;
    return !this.isExpired();
  }

  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }

  getPrompt(): string {
    return `Frida wants to: ${this.tool}(${JSON.stringify(this.params)}). Reply "CONFIRM ${this.nonce}" to approve.`;
  }
}
