import { GatewayCloseCodes } from "discord-api-types/v10";
export declare function isFatalGatewayCloseCode(code: GatewayCloseCodes): boolean;
export declare function canResumeAfterGatewayClose(code: GatewayCloseCodes): boolean;
