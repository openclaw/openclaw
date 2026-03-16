/**
 * Gateway Probe plugin entry point.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createGatewayProbeService } from "./src/service.js";

const plugin = {
  id: "gateway-probe",
  name: "Gateway Probe",
  description: "Observe-only gateway telemetry collector with optional Kafka output",

  register(api: OpenClawPluginApi) {
    api.registerService(createGatewayProbeService(api));
  },
};

export default plugin;
