import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { GatewaySnapshot } from "./types";

const GATEWAY_STATUS_EVENT = "gateway-status";

export function getGatewaySnapshot() {
  return invoke<GatewaySnapshot>("get_gateway_snapshot");
}

export function restartGateway() {
  return invoke<GatewaySnapshot>("restart_gateway");
}

export function listenForGatewayStatus(handler: (snapshot: GatewaySnapshot) => void) {
  return listen<GatewaySnapshot>(GATEWAY_STATUS_EVENT, (event) => {
    handler(event.payload);
  });
}
