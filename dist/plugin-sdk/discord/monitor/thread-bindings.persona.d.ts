import type { ThreadBindingRecord } from "./thread-bindings.types.js";
export declare function resolveThreadBindingPersona(params: {
    label?: string;
    agentId?: string;
}): string;
export declare function resolveThreadBindingPersonaFromRecord(record: ThreadBindingRecord): string;
