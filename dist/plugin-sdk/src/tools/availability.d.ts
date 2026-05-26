import type { ToolAvailabilityContext, ToolAvailabilityDiagnostic, ToolDescriptor } from "./types.js";
export declare function evaluateToolAvailability(params: {
    descriptor: ToolDescriptor;
    context?: ToolAvailabilityContext;
}): readonly ToolAvailabilityDiagnostic[];
