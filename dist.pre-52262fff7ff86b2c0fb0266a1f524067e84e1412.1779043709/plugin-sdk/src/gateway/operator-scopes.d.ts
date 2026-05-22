export declare const ADMIN_SCOPE: "operator.admin";
export declare const READ_SCOPE: "operator.read";
export declare const WRITE_SCOPE: "operator.write";
export declare const APPROVALS_SCOPE: "operator.approvals";
export declare const PAIRING_SCOPE: "operator.pairing";
export declare const TALK_SECRETS_SCOPE: "operator.talk.secrets";
export type OperatorScope = typeof ADMIN_SCOPE | typeof READ_SCOPE | typeof WRITE_SCOPE | typeof APPROVALS_SCOPE | typeof PAIRING_SCOPE | typeof TALK_SECRETS_SCOPE;
export declare function isOperatorScope(value: unknown): value is OperatorScope;
