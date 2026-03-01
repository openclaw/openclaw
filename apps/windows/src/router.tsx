import { createBrowserRouter } from "react-router";
import HydrateFallback from "./components/hydrate-fallback";

export default createBrowserRouter([
  {
    path: "/setup",
    lazy: {
      Component: async () => (await import("./screens/setup")).default,
    },
    children: [
      {
        index: true,
        lazy: async () => ({
          Component: (await import("./screens/setup/pages/welcome")).default,
        }),
      },
      {
        path: "welcome",
        lazy: async () => ({
          Component: (await import("./screens/setup/pages/welcome")).default,
        }),
      },
      {
        path: "connect",
        lazy: async () => ({
          Component: (await import("./screens/setup/pages/connect")).default,
        }),
      },
      {
        path: "install-mode",
        lazy: async () => {
          const { SetupInstallMode } =
            await import("./screens/setup/pages/install-mode");
          return { Component: SetupInstallMode };
        },
      },
      {
        path: "install",
        lazy: async () => {
          const { SetupInstall } =
            await import("./screens/setup/pages/install");
          return { Component: SetupInstall };
        },
      },
      {
        path: "onboard",
        lazy: async () => {
          const { SetupOnboard } =
            await import("./screens/setup/pages/onboard");
          return { Component: SetupOnboard };
        },
      },
      {
        path: "connecting",
        lazy: async () => {
          const { SetupConnecting } =
            await import("./screens/setup/pages/connecting");
          return { Component: SetupConnecting };
        },
      },
    ],
    HydrateFallback: HydrateFallback,
  },
  {
    path: "/voice-overlay",
    lazy: async () => {
      const { VoiceOverlay } = await import("./screens/voice-overlay");
      return { Component: VoiceOverlay };
    },
    HydrateFallback: HydrateFallback,
  },
  {
    path: "/tray-menu",
    lazy: async () => {
      const { TrayMenu } = await import("./screens/tray-menu");
      return { Component: TrayMenu };
    },
    HydrateFallback: HydrateFallback,
  },
  {
    path: "/settings",
    lazy: async () => {
      const { default: Settings } = await import("./screens/settings");
      return { Component: Settings };
    },
    HydrateFallback: HydrateFallback,
  },
  {
    path: "/exec-prompt",
    lazy: async () => {
      const { default: ExecApprovalScreen } =
        await import("./screens/exec-approval");
      return { Component: ExecApprovalScreen };
    },
    HydrateFallback: HydrateFallback,
  },
  {
    path: "/notification",
    lazy: async () => {
      const { NotificationScreen } = await import("./screens/notification");
      return { Component: NotificationScreen };
    },
    HydrateFallback: HydrateFallback,
  },
]);
