import type { MatrixClient } from "./sdk.js";

let activeClient: MatrixClient | null = null;

export function setActiveMatrixClient(client: MatrixClient | null): void {
  activeClient = client;
}

export function getActiveMatrixClient(): MatrixClient | null {
  return activeClient;
}
