import { SYSTEM_MARK } from "../../../../src/infra/system-message.js";
const THREAD_BINDING_PERSONA_MAX_CHARS = 80;
function normalizePersonaLabel(value) {
  if (!value) {
    return void 0;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || void 0;
}
function resolveThreadBindingPersona(params) {
  const base = normalizePersonaLabel(params.label) || normalizePersonaLabel(params.agentId) || "agent";
  return `${SYSTEM_MARK} ${base}`.slice(0, THREAD_BINDING_PERSONA_MAX_CHARS);
}
function resolveThreadBindingPersonaFromRecord(record) {
  return resolveThreadBindingPersona({
    label: record.label,
    agentId: record.agentId
  });
}
export {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord
};
