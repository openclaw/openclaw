declare const GATEWAY_ROLES: readonly ["operator", "node"];
export type GatewayRole = (typeof GATEWAY_ROLES)[number];
export declare function parseGatewayRole(roleRaw: unknown): GatewayRole | null;
export declare function roleCanSkipDeviceIdentity(role: GatewayRole, sharedAuthOk: boolean): boolean;
export declare function isRoleAuthorizedForMethod(role: GatewayRole, method: string): boolean;
export {};
