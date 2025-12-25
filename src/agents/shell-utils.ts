import { spawn } from "node:child_process";

export function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    const shell = process.env.COMSPEC?.trim() || "cmd.exe";
    return { shell, args: ["/d", "/s", "/c"] };
  }

  const shell = process.env.SHELL?.trim() || "sh";
  return { shell, args: ["-c"] };
}

export function sanitizeBinaryOutput(text: string): string {
  return text
    .replace(/[\p{Format}\p{Surrogate}]/gu, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // ignore errors if taskkill fails
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process already dead
    }
  }
}
