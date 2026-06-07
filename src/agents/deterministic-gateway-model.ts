export const DETERMINISTIC_GATEWAY_PROVIDER = "dummy";
export const DETERMINISTIC_GATEWAY_MODEL = "dummy";
export const DETERMINISTIC_GATEWAY_MODEL_REF = `${DETERMINISTIC_GATEWAY_PROVIDER}/${DETERMINISTIC_GATEWAY_MODEL}`;
export const DETERMINISTIC_GATEWAY_REPLY =
  "No AI is configured. This gateway is running in deterministic mode. Use /tools to view available tools.";

export function isDeterministicGatewayModel(provider: string, model: string): boolean {
  return (
    provider.trim().toLowerCase() === DETERMINISTIC_GATEWAY_PROVIDER &&
    model.trim().toLowerCase() === DETERMINISTIC_GATEWAY_MODEL
  );
}
