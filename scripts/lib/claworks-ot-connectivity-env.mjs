/**
 * OT connector env validation — read-only; no socket connections.
 */

const CONNECTOR_ENV = {
  mqtt: {
    required: ["CLAWORKS_MQTT_URL", "CLAWORKS_MQTT_TOPIC"],
    simulate: "CLAWORKS_MQTT_SIMULATE",
  },
  opcua: {
    required: ["CLAWORKS_OPCUA_ENDPOINT"],
    simulate: "CLAWORKS_OPCUA_SIMULATE",
  },
  modbus: {
    required: ["CLAWORKS_MODBUS_HOST"],
    simulate: "CLAWORKS_MODBUS_SIMULATE",
  },
};

function isTruthySimulate(value) {
  const v = value?.trim();
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * @param {Record<string, { preset?: string; simulate?: boolean; enabled?: boolean }>} connectors
 * @param {NodeJS.ProcessEnv} env
 */
export function auditOtConnectorEnv(connectors, env = process.env) {
  const findings = [];
  for (const [id, cfg] of Object.entries(connectors ?? {})) {
    if (cfg?.enabled === false) {
      continue;
    }
    const preset = cfg?.preset?.replace(/-simulate$/, "") ?? "";
    const rule = CONNECTOR_ENV[preset];
    if (!rule) {
      continue;
    }
    const live = cfg?.simulate === false;
    if (!live) {
      continue;
    }
    for (const key of rule.required) {
      if (!env[key]?.trim()) {
        findings.push({
          id,
          preset,
          level: "error",
          message: `missing env ${key} for live ${preset}`,
        });
      }
    }
    if (isTruthySimulate(env[rule.simulate])) {
      findings.push({
        id,
        preset,
        level: "error",
        message: `${rule.simulate}=1 conflicts with simulate:false`,
      });
    }
  }
  return findings;
}

export { CONNECTOR_ENV };
