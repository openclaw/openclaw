import type { OpenClawConfig } from "../config/config.js";
export declare const EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR = "Invalid config: gateway.auth.token and gateway.auth.password are both configured, but gateway.auth.mode is unset. Set gateway.auth.mode to token or password.";
export declare function hasAmbiguousGatewayAuthModeConfig(cfg: OpenClawConfig): boolean;
export declare function assertExplicitGatewayAuthModeWhenBothConfigured(cfg: OpenClawConfig): void;
