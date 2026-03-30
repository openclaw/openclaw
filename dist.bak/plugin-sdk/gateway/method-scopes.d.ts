export declare const ADMIN_SCOPE: "operator.admin";
export declare const READ_SCOPE: "operator.read";
export declare const WRITE_SCOPE: "operator.write";
export declare const APPROVALS_SCOPE: "operator.approvals";
export declare const PAIRING_SCOPE: "operator.pairing";
export type OperatorScope = typeof ADMIN_SCOPE | typeof READ_SCOPE | typeof WRITE_SCOPE | typeof APPROVALS_SCOPE | typeof PAIRING_SCOPE;
export declare const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[];
export declare function isApprovalMethod(method: string): boolean;
export declare function isPairingMethod(method: string): boolean;
export declare function isReadMethod(method: string): boolean;
export declare function isWriteMethod(method: string): boolean;
export declare function isNodeRoleMethod(method: string): boolean;
export declare function isAdminOnlyMethod(method: string): boolean;
export declare function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined;
export declare function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[];
export declare function authorizeOperatorScopesForMethod(method: string, scopes: readonly string[]): {
    allowed: true;
} | {
    allowed: false;
    missingScope: OperatorScope;
};
export declare function isGatewayMethodClassified(method: string): boolean;
