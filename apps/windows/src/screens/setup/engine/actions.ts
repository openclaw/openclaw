import { assign } from "xstate";
import { SetupEvent } from "./flow.types";

export const setMode = assign({
  mode: ({ event }: { event: SetupEvent }) =>
    event.type === "SET_MODE" ? event.mode : undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

export const setInstallMode = assign({
  installMode: ({ event }: { event: SetupEvent }) => {
    if (event.type !== "SET_INSTALL_MODE") return undefined;
    return event.installMode;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

export const setWslDistro = assign({
  wslDistro: ({ event }: { event: SetupEvent }) => {
    if (event.type !== "SET_WSL_DISTRO") return undefined;
    return event.distro;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

export const acceptTerms = assign({
  acceptedTerms: () => true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

export const setInstallPath = assign({
  installPath: ({ event }: { event: SetupEvent }) => {
    if (event.type !== "SET_INSTALL_PATH") return undefined;
    return event.path;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

export const setGatewayConnected = assign({
  gatewayConnected: () => true,
});
