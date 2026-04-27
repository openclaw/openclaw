import { resolveConfiguredBindingRecord, resolveConfiguredBindingRecordBySessionKey, resolveConfiguredBindingRecordForConversation, } from "../channels/plugins/binding-registry.js";
import { resolveConfiguredAcpBindingSpecFromRecord, toResolvedConfiguredAcpBinding, } from "./persistent-bindings.types.js";
export function resolveConfiguredAcpBindingRecord(params) {
    const resolved = resolveConfiguredBindingRecord(params);
    return resolved ? toResolvedConfiguredAcpBinding(resolved.record) : null;
}
export function resolveConfiguredAcpBindingRecordForConversation(params) {
    const resolved = resolveConfiguredBindingRecordForConversation(params);
    return resolved ? toResolvedConfiguredAcpBinding(resolved.record) : null;
}
export function resolveConfiguredAcpBindingSpecBySessionKey(params) {
    const resolved = resolveConfiguredBindingRecordBySessionKey(params);
    return resolved ? resolveConfiguredAcpBindingSpecFromRecord(resolved.record) : null;
}
