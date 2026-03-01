import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GatewayStatus } from "../types/gateway";

class Gateway {
  private static instance: Gateway;
  private gatewayStatus: GatewayStatus = {
    connected: false,
    address: "",
    port: 0,
    gatewayType: "local",
  };
  private statusListeners: Set<(status: GatewayStatus) => void> = new Set();
  private unlistenFn: (() => void) | null = null;

  private constructor() {
    this.refreshStatus();
    this.initListeners();
  }

  public async refreshStatus() {
    try {
      const status = await invoke<GatewayStatus>("get_gateway_status");
      this.updateStatus(status);
    } catch (err) {
      console.error("Failed to fetch gateway status:", err);
    }
  }

  private updateStatus(status: GatewayStatus) {
    this.gatewayStatus = status;
    this.statusListeners.forEach((listener) => listener(this.gatewayStatus));
  }

  private async initListeners() {
    const unlisten = await listen<GatewayStatus>("gateway_status", (event) => {
      this.updateStatus(event.payload);
    });
    this.unlistenFn = unlisten;
  }

  public destroy() {
    this.unlistenFn?.();
    this.unlistenFn = null;
    this.statusListeners.clear();
  }

  public static getInstance(): Gateway {
    if (!Gateway.instance) {
      Gateway.instance = new Gateway();
    }
    return Gateway.instance;
  }

  public async onReady(timeoutMs = 30_000): Promise<GatewayStatus> {
    if (this.gatewayStatus.connected) {
      return this.gatewayStatus;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Gateway connection timed out"));
      }, timeoutMs);

      const unsubscribe = this.onGatewayStatusChange((status) => {
        if (status.connected) {
          clearTimeout(timer);
          unsubscribe();
          resolve(status);
        }
      });
    });
  }

  public getGatewayStatus(): GatewayStatus {
    return this.gatewayStatus;
  }

  public onGatewayStatusChange(callback: (status: GatewayStatus) => void) {
    this.statusListeners.add(callback);
    callback(this.gatewayStatus); // Initial call
    return () => {
      this.statusListeners.delete(callback);
    };
  }
}

const gatewayInstance = Gateway.getInstance();
export default gatewayInstance;

export function useGateway() {
  const [status, setStatus] = useState<GatewayStatus>(
    gatewayInstance.getGatewayStatus()
  );

  useEffect(() => {
    return gatewayInstance.onGatewayStatusChange(setStatus);
  }, []);

  return status;
}
