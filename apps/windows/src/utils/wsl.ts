import { invoke } from "@tauri-apps/api/core";

export const isWSLInstalled = async (): Promise<boolean> => {
  return invoke("check_wsl_status");
};

export const getWSLDistro = async (): Promise<string | undefined> => {
  return invoke("get_wsl_distro");
};
