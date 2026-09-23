import {
  CRABBOX_MACOS_APP_PATH,
  crabboxMacosDesktopDirectory,
  createCrabboxMacosGuiLaunchScript,
} from "./crabbox-worker-desktop-macos.js";
import { createCrabboxWindowsDesktopNodeLauncher } from "./crabbox-worker-desktop-windows.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";

/** The enrollment script and native desktop host share one process receipt contract. */
export function createCrabboxNodeProcessRuntime(
  desktopTarget: CrabboxOperatingSystem | undefined,
  leaseId: string,
): string {
  return `const desktopTarget = ${JSON.stringify(desktopTarget)};
${desktopTarget === "windows/normal" ? createCrabboxWindowsDesktopNodeLauncher() : ""}
  const probeProcess = (binary, args, timeout = process.platform === "win32" ? 10000 : 2000) => {
    const result = spawnSync(binary, args, { env: nodeEnv, encoding: "utf8", windowsHide: true, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    return result.status === 0 && !result.error ? result.stdout.trim() : null;
  };
  const processStartTime = (pid) => probeProcess("ps", ["-o", "lstart=", "-p", String(pid)])?.replace(/\\s+/g, " ");
  const processCwdMatches = (pid) => {
    const args = ["-a", "-p", String(pid), "-d", "cwd", "-Fn"];
    const output = probeProcess("lsof", args) ?? probeProcess("/usr/sbin/lsof", args);
    const cwd = output?.split("\\n").filter((line) => line.startsWith("n"));
    return cwd?.length === 1 && fs.realpathSync(cwd[0].slice(1)) === runtimeDir;
  };
  const macosHostPath = ${JSON.stringify(`${CRABBOX_MACOS_APP_PATH}/Contents/MacOS/OpenClaw`)};
  const macosDesktopDirectory = ${JSON.stringify(desktopTarget === "macos" ? crabboxMacosDesktopDirectory(leaseId) : undefined)};
  const macosGuiLaunchScript = ${JSON.stringify(desktopTarget === "macos" ? createCrabboxMacosGuiLaunchScript() : undefined)};
  const macosHostArgs = (enrollmentMode) => ["--cloud-worker-host", "--node-executable", process.execPath, "--runtime-dir", runtimeDir, "--state-dir", stateDir, "--desktop-dir", macosDesktopDirectory, "--lease-id", leaseId, "--display-name", displayName, "--enrollment-mode", enrollmentMode];
  const inspectMacosHost = (launch, nodePid) => {
    if (!launch || !Number.isSafeInteger(launch.hostPid) || launch.hostPid < 1 || typeof launch.hostStartTime !== "string" || !launch.hostStartTime) return null;
    let actual;
    try { actual = JSON.parse(probeProcess(macosHostPath, ["--cloud-worker-inspect-process", String(launch.hostPid), ...(nodePid === undefined ? [] : [String(nodePid)])], 10000) ?? "null"); }
    catch { return null; }
    if (actual?.state === "gone" && Object.keys(actual).length === 1) return actual;
    return actual?.state === "active" && actual.host ? actual : null;
  };
  const macosRuntimeDirectory = () => {
    const stat = fs.statSync(runtimeDir, { bigint: true });
    return { device: BigInt.asUintN(32, stat.dev).toString(), inode: stat.ino.toString() };
  };
  const macosCwdMatches = (actual, expected) => actual?.device === expected.device && actual?.inode === expected.inode;
  const macosHostMatches = (launch, host, directory) => {
    if (!host || host.pid !== launch.hostPid || host.startTime !== launch.hostStartTime || host.uid !== process.getuid() || !macosCwdMatches(host.cwd, directory) || !Array.isArray(host.arguments)) return false;
    return ["connect", "resume"].some((value) => {
      const expected = [macosHostPath, ...macosHostArgs(value)];
      return expected.length === host.arguments.length && expected.every((argument, index) => argument === host.arguments[index]);
    });
  };
  const verifyMacosHost = (launch) => {
    const actual = inspectMacosHost(launch);
    return actual?.state === "active" && macosHostMatches(launch, actual.host, macosRuntimeDirectory());
  };
  const verifyMacosNode = (launch, pid) => {
    if (launch.pid !== pid || launch.runtimeDir !== runtimeDir || launch.stateDir !== stateDir || launch.cli !== cli) return false;
    const actual = inspectMacosHost(launch, pid);
    const directory = macosRuntimeDirectory();
    const node = actual?.node;
    if (actual?.state !== "active" || !macosHostMatches(launch, actual.host, directory) || !node || node.pid !== pid || node.startTime !== launch.startTime || node.uid !== process.getuid() || node.parentPid !== launch.hostPid || !macosCwdMatches(node.cwd, directory) || !Array.isArray(node.arguments) || fs.realpathSync(node.executablePath) !== fs.realpathSync(process.execPath)) return false;
    return ["openclaw", "openclaw-connect", "openclaw-node"].includes(node.arguments[0]) || (node.arguments.length >= 2 && fs.realpathSync(node.arguments[0]) === fs.realpathSync(process.execPath) && node.arguments[1] === cli);
  };
  const verifyDarwinNode = (launch, pid) => {
    const startTime = processStartTime(pid);
    const command = probeProcess("ps", ["-ww", "-o", "command=", "-p", String(pid)]);
    const invocation = process.execPath + " " + cli;
    const nodeInvocation = command !== null && (["openclaw", "openclaw-connect", "openclaw-node"].includes(command) || command === invocation || command.startsWith(invocation + " "));
    return launch.pid === pid && Boolean(startTime) && launch.startTime === startTime && launch.runtimeDir === runtimeDir && launch.stateDir === stateDir && launch.cli === cli && nodeInvocation && processCwdMatches(pid);
  };
  const windowsProcesses = (filter) => {
    const desktopFields = desktopTarget === "windows/normal" ? "; sessionId = $_.SessionId; userSid = [string](Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid" : "";
    const output = probeProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter '" + filter + "' | ForEach-Object { @{ pid = $_.ProcessId; startTime = $_.CreationDate.ToUniversalTime().ToString('o'); executablePath = $_.ExecutablePath; commandLine = $_.CommandLine" + desktopFields + " } }) | ConvertTo-Json -Compress"]);
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  const isWindowsNode = (entry) => {
    if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.startTime !== "string" || !entry.startTime || typeof entry.executablePath !== "string" || typeof entry.commandLine !== "string") return false;
    // Our invocation has exactly executable + CLI before its options. Windows paths
    // cannot contain quotes; accept quoted or unquoted path tokens in those positions.
    // CIM retains this command line even when Node changes the console title.
    const invocation = entry.commandLine.match(/^(?:"([^"]+)"|([^\\s"]+))\\s+(?:"([^"]+)"|([^\\s"]+))(?:\\s|$)/);
    return invocation !== null && (invocation[3] ?? invocation[4]) === cli && fs.realpathSync(invocation[1] ?? invocation[2]) === fs.realpathSync(process.execPath) && fs.realpathSync(entry.executablePath) === fs.realpathSync(process.execPath);
  };
  const reuseNodeProcess = () => {
  const hasPid = mode && fs.existsSync(pidFile);
  if (mode && !hasPid) {
    // The runtime pointer precedes detached launch; a lost PID cannot prove no process survived.
    for (const previous of [runtimeLink, launchFile]) {
      try {
        const entry = fs.lstatSync(previous);
        if (previous === runtimeLink && !entry.isSymbolicLink()) throw new Error("Cloud worker runtime pointer is occupied");
        throw new Error("Cloud worker node launch is incomplete; release and reprovision the worker");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  if (hasPid) {
    const pidText = fs.readFileSync(pidFile, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(pidText)) throw new Error("Cloud worker node PID is invalid; release and reprovision the worker");
    const pid = Number(pidText);
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
    if (alive) {
      let verified = false;
      if (process.platform === "linux") {
        const args = fs.readFileSync(path.join("/proc", pidText, "cmdline"), "utf8").split("\\0");
        const env = fs.readFileSync(path.join("/proc", pidText, "environ"), "utf8").split("\\0");
        // OpenClaw changes process.title; the immutable install cwd survives that argv rewrite.
        const title = args[0];
        const nodeInvocation = args[1] === cli || ["openclaw", "openclaw-connect", "openclaw-node"].includes(title);
        verified = nodeInvocation && fs.realpathSync(path.join("/proc", pidText, "cwd")) === runtimeDir && env.includes("OPENCLAW_STATE_DIR=" + stateDir);
      } else if (process.platform === "win32") {
        try {
          const launch = JSON.parse(fs.readFileSync(launchFile, "utf8"));
          const entries = windowsProcesses("ProcessId=" + pidText);
          const entry = entries.length === 1 ? entries[0] : undefined;
          // Windows exposes no cheap cwd probe. Bind launch-owned cwd/state to the
          // actual node.exe creation time and independently inspect its executable/argv.
          verified = isWindowsNode(entry) && entry.pid === pid && launch.pid === pid && launch.startTime === entry.startTime && launch.runtimeDir === runtimeDir && launch.stateDir === stateDir && launch.cli === cli;
          if (verified && desktopTarget === "windows/normal") {
            const session = readWindowsDesktopSessionIdentity();
            verified = entry.sessionId > 0 && entry.sessionId === session.sessionId && entry.userSid === session.userSid && launch.sessionId === session.sessionId && launch.userSid === session.userSid;
          }
        } catch { verified = false; }
      } else {
        try {
          // Darwin loses ps-visible environment when process.title changes. Bind the launch
          // facts to this live process's start time, then independently verify argv and cwd.
          const launch = JSON.parse(fs.readFileSync(launchFile, "utf8"));
          verified = desktopTarget === "macos" ? verifyMacosNode(launch, pid) : verifyDarwinNode(launch, pid);
        } catch { /* Missing launch or process identity must never authorize replay. */ }
      }
      if (!verified) {
        throw new Error("Cloud worker node is running a different bootstrap artifact or invocation; release and reprovision the worker");
      }
      return true;
    }
    if (desktopTarget === "macos") {
      const launch = JSON.parse(fs.readFileSync(launchFile, "utf8"));
      if (inspectMacosHost(launch)?.state !== "gone") throw new Error("Cloud worker desktop host is still running or could not be verified; release and reprovision the worker");
    }
    fs.unlinkSync(pidFile);
  }
  return false;
  };
  const launchNodeProcess = async () => {
  const args = mode === "connect" ? ["connect", "--target-file", setupFile] : ["node", "run"];
  setPhase("node launch");
  const logPath = path.join(stateDir, "node.log");
  const log = process.platform === "win32" ? undefined : fs.openSync(logPath, "a", 0o600);
  let child;
  let pid;
  let parentPid;
  let startTime;
  let desktopIdentity;
  try {
    const nodeArgs = [cli, ...args, "--ephemeral", "--display-name", displayName];
    if (desktopTarget === "macos") {
      // LaunchServices makes the signed host its own TCC responsibility owner.
      // open is only a waiter; the host's inspected receipt identifies the actual processes.
      child = spawn("/bin/bash", ["-c", macosGuiLaunchScript, "openclaw-gui", "/usr/bin/open", "-n", "-g", "-W", "-a", ${JSON.stringify(CRABBOX_MACOS_APP_PATH)}, "--stdin", "/dev/null", "--stdout", logPath, "--stderr", logPath, "--args", ...macosHostArgs(mode)], { cwd: runtimeDir, env: nodeEnv, detached: true, stdio: ["ignore", log, log] });
      await once(child, "spawn");
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (fs.existsSync(pidFile)) {
          const launch = JSON.parse(fs.readFileSync(launchFile, "utf8"));
          const actualPid = Number(fs.readFileSync(pidFile, "utf8").trim());
          if (!verifyMacosNode(launch, actualPid)) throw new Error("Cloud worker native desktop host published a mismatched process receipt; release and reprovision the worker");
          child.unref();
          return;
        }
        if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) throw new Error("Cloud worker native desktop host exited before enrollment; inspect node.log and reprovision the worker");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Cloud worker native desktop host did not become ready; inspect node.log and reprovision the worker");
    } else if (desktopTarget === "windows/normal") {
      desktopIdentity = await launchWindowsDesktopNode({ nodePath: process.execPath, nodeArgs, cwd: runtimeDir, stateDir, logPath });
      ({ pid, startTime } = desktopIdentity);
    } else if (process.platform === "win32") {
      const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
      // The managed launcher owns OpenSSH job breakaway. Its hidden PowerShell child
      // owns logging because detached processes must not inherit SSH stdio handles.
      const launchScript = "$env:OPENCLAW_STATE_DIR = " + quote(stateDir) + "; & " + [process.execPath, ...nodeArgs].map(quote).join(" ") + " *>> " + quote(logPath) + "; exit $LASTEXITCODE";
      const argumentList = "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(launchScript, "utf16le").toString("base64");
      const launched = probeProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, "-FilePath", "powershell.exe", "-ArgumentList", argumentList, "-WorkingDirectory", runtimeDir]);
      if (!/^[1-9][0-9]*$/.test(launched || "")) throw new Error("Cloud worker managed Windows launcher failed; release and reprovision the worker");
      parentPid = Number(launched);
      const deadline = Date.now() + 30000;
      while (!pid && Date.now() < deadline) {
        const entries = windowsProcesses("ParentProcessId=" + parentPid).filter(isWindowsNode);
        if (entries.length > 1) throw new Error("Cloud worker node invocation is ambiguous; release and reprovision the worker");
        if (entries.length === 1) { pid = entries[0].pid; startTime = entries[0].startTime; }
        else await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!pid) throw new Error("Cloud worker node start time is unavailable; release and reprovision the worker");
    } else {
      child = spawn(process.execPath, nodeArgs, { cwd: runtimeDir, env: nodeEnv, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
      await once(child, "spawn");
      pid = child.pid;
      if (process.platform !== "linux") startTime = processStartTime(pid);
    }
      if (process.platform !== "linux") {
        if (!startTime) throw new Error("Cloud worker node start time is unavailable; release and reprovision the worker");
        const temporary = launchFile + "." + crypto.randomUUID();
        try {
          fs.writeFileSync(temporary, JSON.stringify({ pid, startTime, runtimeDir, stateDir, cli, ...(desktopIdentity ? { sessionId: desktopIdentity.sessionId, userSid: desktopIdentity.userSid } : {}) }), { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, launchFile);
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      fs.writeFileSync(pidFile, String(pid) + "\\n", { mode: 0o600 });
    child?.unref();
  } catch (error) {
    if (desktopTarget === "macos") {
      let confirmedStopped = !child?.pid;
      try {
        let launch;
        try {
          const receipt = JSON.parse(fs.readFileSync(launchFile, "utf8"));
          if (verifyMacosHost(receipt)) launch = receipt;
        } catch { /* A host can fail before publishing its Node receipt. */ }
        if (launch && verifyMacosHost(launch)) {
          process.kill(launch.hostPid, "SIGTERM");
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const current = inspectMacosHost(launch);
            if (current?.state === "gone" || (current?.state === "active" && current.host.pid === launch.hostPid && current.host.startTime !== launch.hostStartTime)) { confirmedStopped = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } catch { /* The provider's lease teardown owns an unconfirmed host launch. */ }
      child?.unref();
      if (!confirmedStopped) error.message += "; native desktop host shutdown could not be confirmed; lease teardown is required";
    } else if (desktopIdentity) {
      const entries = windowsProcesses("ProcessId=" + pid);
      if (entries.length === 1 && isWindowsNode(entries[0]) && entries[0].startTime === startTime) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { env: nodeEnv, windowsHide: true, stdio: "ignore", timeout: 10000 });
    } else if (parentPid) spawnSync("taskkill.exe", ["/PID", String(parentPid), "/T", "/F"], { env: nodeEnv, windowsHide: true, stdio: "ignore", timeout: 10000 });
    else if (pid) process.kill(-pid, "SIGTERM");
    throw error;
  } finally { if (log !== undefined) fs.closeSync(log); }
  };
`;
}
