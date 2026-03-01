import { useRef } from "react";
import { InstallStep, InstallStatus } from "../../../types/installer";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface InstallStatusEvent {
  step: string;
  status: string;
  message: string | null;
}

export const useOpenClawInstaller = (
  updateInstallSteps: (key: string, data: Partial<InstallStep>) => void
) => {
  const isInstalling = useRef(false);

  const abort = async () => {
    try {
      await invoke("abort_installation");
    } catch (err) {
      console.error("Failed to abort installation:", err);
    }
  };

  const check = async (key: string): Promise<boolean> => {
    // Backend installer is idempotent, so pre-check probes are skipped here.
    // Returning false keeps the install flow deterministic.
    console.log("[openclaw] Naive check for key:", key);
    return false;
  };

  const install = (key: string): Promise<void> => {
    if (isInstalling.current) return Promise.resolve();

    // install_openclaw emits per-step events for system/openclaw/doctor.
    // We only invoke it once from the first step ("system").

    if (key !== "system" && key !== "openclaw" && key !== "doctor")
      return Promise.resolve();

    return new Promise((resolve) => {
      (async () => {
        isInstalling.current = true;

        // Start backend install only for the first step in the pipeline.
        if (key === "system") {
          updateInstallSteps("system", { status: "installing" });
          const unlisten = await listen<InstallStatusEvent>(
            "install-status",
            (event) => {
              const { step, status, message } = event.payload;
              updateInstallSteps(step, {
                status: status as InstallStatus,
                subText: message || undefined,
                error:
                  status === "failed" ? message || "Unknown error" : undefined,
              });
            }
          );

          try {
            await invoke("install_openclaw");
          } catch (error) {
            updateInstallSteps(key, { status: "failed", error: String(error) });
          } finally {
            unlisten();
            isInstalling.current = false;
            resolve();
          }
        } else {
          // Later steps are resolved by install-status events from the system run.
          isInstalling.current = false;
          resolve();
        }
      })();
    });
  };

  return {
    install,
    check,
    abort,
  };
};
