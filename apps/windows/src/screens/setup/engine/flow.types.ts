export interface SetupContext {
  mode?: "install" | "configure";
  installMode?: "windows" | "wsl";
  wslDistro?: string;
  installPath?: string;
  acceptedTerms?: boolean;
  gatewayConnected?: boolean;
  systemInfo?: {
    os: string;
    isAdmin: boolean;
  };
}

export type SetupEvent =
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "SET_MODE"; mode: "install" | "configure" }
  | { type: "SET_INSTALL_MODE"; installMode: "windows" | "wsl" }
  | { type: "SET_WSL_DISTRO"; distro: string }
  | { type: "SET_INSTALL_PATH"; path: string }
  | { type: "ACCEPT_TERMS" }
  | { type: "GATEWAY_FOUND" }
  | { type: "RETRY"; key?: string };
