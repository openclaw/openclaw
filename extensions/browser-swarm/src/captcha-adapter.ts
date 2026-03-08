export type CaptchaSolveRequest = {
  provider: "none" | "manual" | "external";
  pageUrl: string;
  siteKey?: string;
  challengeType?: string;
};

export type CaptchaSolveResult =
  | { ok: true; token: string; expiresAt?: number; provider: string }
  | { ok: false; reason: string; retryable: boolean };

export interface CaptchaAdapter {
  solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult>;
}

export class NoopCaptchaAdapter implements CaptchaAdapter {
  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    if (request.provider === "none") {
      return { ok: false, reason: "captcha_solver_disabled", retryable: false };
    }
    return { ok: false, reason: "captcha_solver_not_configured", retryable: false };
  }
}

