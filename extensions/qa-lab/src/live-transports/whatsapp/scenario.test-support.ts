import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { runtimeEnv } from "./runtime.test-support.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import { whatsappScenarioImplementations } from "./scenario-implementations.js";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import type {
  WhatsAppQaRuntimeEnv,
  WhatsAppQaMessageScenarioContext as Context,
} from "./whatsapp-live.contracts.js";

export function scenario(id: string) {
  const definition = requireFlowScenario(readQaScenarioById(id));
  const name = definition.execution.config?.whatsappScenario;
  const implementation = expectDefined(
    typeof name === "string" ? whatsappScenarioImplementations[name] : undefined,
    `WhatsApp implementation for ${id}`,
  );
  return { ...implementation, id, timeoutMs: definition.execution.timeoutMs ?? 60_000 };
}
export function config(
  options: Partial<Parameters<typeof buildWhatsAppQaConfig>[1]> = {},
  base: OpenClawConfig = {},
) {
  return buildWhatsAppQaConfig(base, {
    allowFrom: [runtimeEnv.driverPhoneE164],
    ownerAllowFrom: [runtimeEnv.driverPhoneE164],
    authDir: "/tmp/whatsapp-qa-auth",
    dmPolicy: "allowlist",
    sutAccountId: "sut",
    ...options,
  });
}
export function gateway(call: Context["gateway"]["call"]) {
  return {
    baseUrl: "http://127.0.0.1:1",
    tempRoot: "/qa",
    workspaceDir: "/tmp/openclaw-whatsapp-qa",
    runtimeEnv: {},
    restart: async () => {},
    call,
  };
}
export function environment(
  getDriver: Parameters<typeof createWhatsAppQaScenarioEnvironment>[0]["getDriver"],
  accountId = "sut",
  env: WhatsAppQaRuntimeEnv = runtimeEnv,
) {
  return createWhatsAppQaScenarioEnvironment({
    accountId,
    driverAuthDir: "/qa/driver",
    explicitScenarioSelection: true,
    getDriver,
    replaceDriver: async () => {},
    runtimeEnv: env,
    sutAuthDir: "/qa/sut",
  });
}
