import { useRef } from "react";
import { getWSLDistro } from "../../../utils/wsl";
import { useSetup } from "../context";
import { InstallStep, InstallStatus } from "../../../types/installer";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface InstallStatusEvent {
  step: string;
  status: string;
  message: string | null;
}

export const useWSLInstaller = (
  updateInstallSteps: (key: string, data: Partial<InstallStep>) => void
) => {
  const isInstalling = useRef(false);
  const { updateInstallData } = useSetup();

  const abort = async () => {
    if (!isInstalling.current) return;
    try {
      await invoke("abort_installation");
      updateInstallSteps("wsl", {
        status: "failed",
        error: "Installation aborted by user",
      });
    } catch (err) {
      console.error("Failed to abort WSL installation:", err);
    } finally {
      isInstalling.current = false;
    }
  };

  const install = (): Promise<void> => {
    if (isInstalling.current) return Promise.resolve();

    return new Promise((resolve) => {
      (async () => {
        updateInstallSteps("wsl", { status: "installing" });
        isInstalling.current = true;

        const unlisten = await listen<InstallStatusEvent>(
          "install-status",
          (event) => {
            const { step, status, message } = event.payload;
            if (step === "wsl") {
              updateInstallSteps("wsl", {
                status: status as InstallStatus,
                subText: message || undefined,
                error:
                  status === "failed" ? message || "Unknown error" : undefined,
              });
            }
          }
        );

        try {
          await invoke("install_wsl");

          // Success path
          const wslDistro = await getWSLDistro();
          updateInstallData({ wslDistro });
          updateInstallSteps("wsl", {
            title: `WSL (${wslDistro}) installed`,
            status: "installed",
            subText: undefined,
          });
        } catch (error) {
          updateInstallSteps("wsl", {
            title: "Failed to install WSL",
            status: "failed",
            error: String(error),
          });
        } finally {
          unlisten();
          isInstalling.current = false;
          resolve();
        }
      })();
    });
  };

  return {
    install,
    abort,
  };
};
