import { run } from "./host-command.ts";
import type { PhaseRunner } from "./phase-runner.ts";
import { encodePowerShell } from "./powershell.ts";
import type { CommandResult } from "./types.ts";

export interface GuestExecOptions {
  check?: boolean;
  timeoutMs?: number;
}

export class LinuxGuest {
  constructor(
    private vmName: string,
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: GuestExecOptions = {}): string {
    const result = run("prlctl", ["exec", this.vmName, "/usr/bin/env", "HOME=/root", ...args], {
      check: options.check,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    return result.stdout.trim();
  }

  bash(script: string): string {
    const encoded = Buffer.from(script, "utf8").toString("base64");
    return this.exec(["bash", "-lc", `printf '%s' '${encoded}' | base64 -d | bash`]);
  }
}

export interface MacosGuestOptions extends GuestExecOptions {
  env?: Record<string, string>;
}

export class MacosGuest {
  constructor(
    private input: {
      vmName: string;
      getUser: () => string;
      getTransport: () => "current-user" | "sudo";
      resolveDesktopHome: (user: string) => string;
      path: string;
    },
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: MacosGuestOptions = {}): string {
    return this.run(args, options).stdout.trim();
  }

  run(args: string[], options: MacosGuestOptions = {}): CommandResult {
    const envArgs = Object.entries({ PATH: this.input.path, ...options.env }).map(
      ([key, value]) => `${key}=${value}`,
    );
    const user = this.input.getUser();
    const transportArgs =
      this.input.getTransport() === "sudo"
        ? [
            "exec",
            this.input.vmName,
            "/usr/bin/sudo",
            "-H",
            "-u",
            user,
            "/usr/bin/env",
            `HOME=${this.input.resolveDesktopHome(user)}`,
            `USER=${user}`,
            `LOGNAME=${user}`,
            ...envArgs,
            ...args,
          ]
        : ["exec", this.input.vmName, "--current-user", "/usr/bin/env", ...envArgs, ...args];
    const result = run("prlctl", transportArgs, {
      check: options.check,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    return result;
  }

  sh(script: string, env: Record<string, string> = {}): string {
    return this.exec(["/bin/bash", "-lc", script], { env });
  }
}

export class WindowsGuest {
  constructor(
    private vmName: string,
    private phases: PhaseRunner,
  ) {}

  exec(args: string[], options: GuestExecOptions = {}): string {
    const result = run("prlctl", ["exec", this.vmName, "--current-user", ...args], {
      check: options.check,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(options.timeoutMs),
    });
    this.phases.append(result.stdout);
    this.phases.append(result.stderr);
    return result.stdout.trim();
  }

  powershell(script: string, options: GuestExecOptions = {}): string {
    return this.exec(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(script),
      ],
      options,
    );
  }
}
