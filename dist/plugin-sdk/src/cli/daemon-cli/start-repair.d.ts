import type { GatewayService, GatewayServiceStartRepairIssue, GatewayServiceState } from "../../daemon/service.js";
export declare function repairLoadedGatewayServiceForStart(params: {
    service: GatewayService;
    state: GatewayServiceState;
    issues: GatewayServiceStartRepairIssue[];
    json: boolean;
    stdout: NodeJS.WritableStream;
}): Promise<{
    result: "started";
    message: string;
    warnings?: string[];
    loaded: boolean;
}>;
