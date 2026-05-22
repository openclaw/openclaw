export declare const whatsappApprovalAuth: {
    authorizeActorAction({ cfg, accountId, senderId, approvalKind, }: {
        cfg: import("openclaw/plugin-sdk").OpenClawConfig;
        accountId?: string | null;
        senderId?: string | null;
        action: "approve";
        approvalKind: "exec" | "plugin";
    }): {
        authorized: boolean;
        reason?: string;
    } | {
        reason?: undefined;
        readonly authorized: true;
    } | {
        readonly authorized: false;
        readonly reason: `\u274C You are not authorized to approve exec requests on ${string}.` | `\u274C You are not authorized to approve plugin requests on ${string}.`;
    };
};
