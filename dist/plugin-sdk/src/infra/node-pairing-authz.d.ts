export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";
export declare function resolveNodePairApprovalScopes(commands: unknown): NodeApprovalScope[];
