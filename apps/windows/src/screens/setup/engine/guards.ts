import { SetupContext } from "./flow.types";

export const termsAccepted = ({ context }: { context: SetupContext }) =>
  !!context.acceptedTerms;

export const isValidInstallPath = ({ context }: { context: SetupContext }) =>
  !!context.installPath && context.installPath.length > 3;

export const isInstallMode = ({ context }: { context: SetupContext }) =>
  context.mode === "install";

export const isConfigureMode = ({ context }: { context: SetupContext }) =>
  context.mode === "configure";

export const hasWslDistro = ({ context }: { context: SetupContext }) =>
  context.installMode === "wsl" ? !!context.wslDistro : true;
