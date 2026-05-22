import type { ResolvedGatewayAuth } from "./auth.js";
export declare const KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS: readonly ["change-me-to-a-long-random-token", "change-me-now"];
export declare const KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS: readonly ["change-me-to-a-strong-password"];
export declare function assertGatewayAuthNotKnownWeak(auth: ResolvedGatewayAuth): void;
