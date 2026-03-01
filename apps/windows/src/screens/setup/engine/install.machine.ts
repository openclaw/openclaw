import { setup, assign } from "xstate";
import { InstallStep } from "../../../types/installer";

export type InstallContext = {
  steps: InstallStep[];
  error?: string;
  installMode: "wsl" | "windows";
  wslDistro?: string;
};

export type InstallEvent =
  | { type: "START" }
  | { type: "STEP_START"; key: string }
  | { type: "STEP_SUCCESS"; key: string; subText?: string }
  | { type: "STEP_FAILURE"; key: string; error: string }
  | { type: "RETRY"; key: string }
  | { type: "ABORT" };

export const installMachine = setup({
  types: {
    context: {} as InstallContext,
    events: {} as InstallEvent,
    input: {} as { installMode: "wsl" | "windows"; wslDistro?: string },
  },
}).createMachine({
  id: "install",
  initial: "idle",
  context: ({ input }) => ({
    steps: [
      {
        key: "wsl",
        title: input.wslDistro
          ? `WSL (${input.wslDistro}) installed`
          : "Installing WSL",
        status: input.wslDistro ? "installed" : "pending",
        mode: "wsl",
      },
      { key: "system", title: "System Dependencies", status: "pending" },
      { key: "openclaw", title: "OpenClaw CLI", status: "pending" },
      { key: "doctor", title: "Verify", status: "pending" },
    ],
    installMode: input.installMode,
    wslDistro: input.wslDistro,
    error: undefined,
  }),
  states: {
    idle: {
      on: {
        START: "processing",
      },
    },
    processing: {
      always: [
        {
          target: "completed",
          guard: ({ context }: { context: InstallContext }) =>
            context.steps
              .filter((s) => !s.mode || s.mode === context.installMode)
              .every((s) => s.status === "installed"),
        },
      ],
      on: {
        STEP_START: {
          actions: assign({
            steps: ({
              context,
              event,
            }: {
              context: InstallContext;
              event: InstallEvent;
            }) => {
              if (event.type !== "STEP_START") return context.steps;
              return context.steps.map((s) =>
                s.key === event.key ? { ...s, status: "installing" } : s
              );
            },
          }),
        },
        STEP_SUCCESS: {
          actions: assign({
            steps: ({
              context,
              event,
            }: {
              context: InstallContext;
              event: InstallEvent;
            }) => {
              if (event.type !== "STEP_SUCCESS") return context.steps;
              return context.steps.map((s) =>
                s.key === event.key
                  ? { ...s, status: "installed", subText: event.subText }
                  : s
              );
            },
          }),
        },
        STEP_FAILURE: {
          target: "failed",
          actions: assign({
            steps: ({
              context,
              event,
            }: {
              context: InstallContext;
              event: InstallEvent;
            }) => {
              if (event.type !== "STEP_FAILURE") return context.steps;
              return context.steps.map((s) =>
                s.key === event.key
                  ? { ...s, status: "failed", error: event.error }
                  : s
              );
            },
            error: ({ event }: { event: InstallEvent }) =>
              event.type === "STEP_FAILURE" ? event.error : undefined,
          }),
        },
      },
    },
    failed: {
      on: {
        RETRY: "processing",
      },
    },
    completed: {
      type: "final",
    },
  },
  on: {
    ABORT: ".idle",
  },
});
