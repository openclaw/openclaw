import fs from "node:fs";
import path from "node:path";

export function resolvePowerShellPath(): string {
  // Prefer PowerShell 7 when available; PS 5.1 lacks "&&" support.
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh7)) {
    return pwsh7;
  }

  const programW6432 = process.env.ProgramW6432;
  if (programW6432 && programW6432 !== programFiles) {
    const pwsh7Alt = path.join(programW6432, "PowerShell", "7", "pwsh.exe");
    if (fs.existsSync(pwsh7Alt)) {
      return pwsh7Alt;
    }
  }

  const pwshInPath = resolveShellFromPath("pwsh");
  if (pwshInPath) {
    return pwshInPath;
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}

export function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // Helper to validate and return shell config for a given path
    const getShellConfigForPath = (shellPath: string): { shell: string; args: string[] } | null => {
      // Skip POSIX-style paths (e.g., /usr/bin/bash from Git Bash)
      // These are not valid Windows paths and would cause ENOENT errors.
      if (shellPath.startsWith("/") && !shellPath.startsWith("//")) {
        return null;
      }

      const shellName = path.basename(shellPath).toLowerCase();

      // PowerShell needs special args even when explicitly configured
      if (shellName.includes("powershell") || shellName === "pwsh.exe" || shellName === "pwsh") {
        return { shell: shellPath, args: ["-NoProfile", "-NonInteractive", "-Command"] };
      }

      // cmd.exe needs /c not -c
      if (shellName === "cmd.exe" || shellName === "cmd") {
        return { shell: shellPath, args: ["/c"] };
      }

      // For other shells, use -c (works for bash, zsh, nushell, etc.)
      return { shell: shellPath, args: ["-c"] };
    };

    // Try OPENCLAW_SHELL first, then SHELL
    // Each is validated independently so a stale OPENCLAW_SHELL doesn't block a valid SHELL
    const overrideShell = process.env.OPENCLAW_SHELL?.trim();
    if (overrideShell) {
      const config = getShellConfigForPath(overrideShell);
      if (config) return config;
    }

    const envShell = process.env.SHELL?.trim();
    if (envShell) {
      const config = getShellConfigForPath(envShell);
      if (config) return config;
    }

    // Use PowerShell instead of cmd.exe on Windows.
    // Problem: Many Windows system utilities (ipconfig, systeminfo, etc.) write
    // directly to the console via WriteConsole API, bypassing stdout pipes.
    // When Node.js spawns cmd.exe with piped stdio, these utilities produce no output.
    // PowerShell properly captures and redirects their output to stdout.
    return {
      shell: resolvePowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }

  const envShell = process.env.SHELL?.trim();
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms used by tools, so prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveShellFromPath("bash");
    if (bash) {
      return { shell: bash, args: ["-c"] };
    }
    const sh = resolveShellFromPath("sh");
    if (sh) {
      return { shell: sh, args: ["-c"] };
    }
  }
  const shell = envShell && envShell.length > 0 ? envShell : "sh";
  return { shell, args: ["-c"] };
}

export function resolveShellFromPath(name: string): string | undefined {
  const envPath = process.env.PATH ?? "";
  if (!envPath) {
    return undefined;
  }
  const entries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // ignore missing or non-executable entries
    }
  }
  return undefined;
}

function normalizeShellName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return path
    .basename(trimmed)
    .replace(/\.(exe|cmd|bat)$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

export function detectRuntimeShell(): string | undefined {
  // Helper to validate and return shell name for a given path
  const getShellNameForPath = (shellPath: string): string | null => {
    // On Windows, skip POSIX-style paths (e.g., /usr/bin/bash from Git Bash)
    // These are not valid Windows paths and should fall back to PowerShell
    if (process.platform === "win32" && shellPath.startsWith("/") && !shellPath.startsWith("//")) {
      return null;
    }
    return normalizeShellName(shellPath) || null;
  };

  // Try OPENCLAW_SHELL first, then SHELL
  // Each is validated independently so a stale OPENCLAW_SHELL doesn't block a valid SHELL
  const overrideShell = process.env.OPENCLAW_SHELL?.trim();
  if (overrideShell) {
    const name = getShellNameForPath(overrideShell);
    if (name) return name;
  }

  if (process.platform === "win32") {
    const envShell = process.env.SHELL?.trim();
    if (envShell) {
      const name = getShellNameForPath(envShell);
      if (name) return name;
    }
    if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
      return "pwsh";
    }
    return "powershell";
  }

  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    const name = normalizeShellName(envShell);
    if (name) {
      return name;
    }
  }

  if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
    return "pwsh";
  }
  if (process.env.BASH_VERSION) {
    return "bash";
  }
  if (process.env.ZSH_VERSION) {
    return "zsh";
  }
  if (process.env.FISH_VERSION) {
    return "fish";
  }
  if (process.env.KSH_VERSION) {
    return "ksh";
  }
  if (process.env.NU_VERSION || process.env.NUSHELL_VERSION) {
    return "nu";
  }

  return undefined;
}

export function sanitizeBinaryOutput(text: string): string {
  const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
  if (!scrubbed) {
    return scrubbed;
  }
  const chunks: string[] = [];
  for (const char of scrubbed) {
    const code = char.codePointAt(0);
    if (code == null) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      chunks.push(char);
      continue;
    }
    if (code < 0x20) {
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

