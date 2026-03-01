import { createMachine } from "xstate";
import { SetupContext, SetupEvent } from "./flow.types";
import * as guards from "./guards";
import * as actions from "./actions";

export const setupMachine = createMachine(
  {
    id: "setup",
    initial: "welcome",
    context: {
      installMode: "wsl",
    } as SetupContext,
    types: {} as {
      context: SetupContext;
      events: SetupEvent;
    },
    states: {
      welcome: {
        on: {
          NEXT: {
            target: "connect",
          },
          ACCEPT_TERMS: {
            actions: "acceptTerms",
          },
        },
      },

      connect: {
        on: {
          SET_MODE: {
            actions: "setMode",
            target: "mode",
          },
          NEXT: "#setup.complete",
          BACK: "welcome",
        },
      },

      mode: {
        on: {
          SET_MODE: {
            actions: "setMode",
          },
          SET_INSTALL_MODE: {
            actions: "setInstallMode",
          },
          SET_WSL_DISTRO: {
            actions: "setWslDistro",
          },
          NEXT: [
            {
              target: "install",
              guard: ({ context }) => context.mode === "install",
            },
            {
              target: "configure",
              guard: ({ context }) => context.mode === "configure",
            },
          ],
          BACK: "connect",
        },
      },

      install: {
        initial: "progress",
        on: {
          BACK: "mode",
        },
        states: {
          progress: {
            on: {
              NEXT: "#setup.configure",
            },
          },
        },
      },

      configure: {
        initial: "onboard",
        on: {
          BACK: "mode",
        },
        states: {
          onboard: {
            on: {
              NEXT: {
                target: "connecting",
              },
            },
          },
          connecting: {
            on: {
              NEXT: "#setup.complete",
            },
          },
        },
      },

      complete: {
        type: "final",
      },
    },
  },
  {
    actions: {
      acceptTerms: actions.acceptTerms,
      setMode: actions.setMode,
      setInstallMode: actions.setInstallMode,
      setWslDistro: actions.setWslDistro,
      setInstallPath: actions.setInstallPath,
    },
    guards: {
      termsAccepted: guards.termsAccepted,
      hasWslDistro: guards.hasWslDistro,
      isValidInstallPath: guards.isValidInstallPath,
    },
  }
);
