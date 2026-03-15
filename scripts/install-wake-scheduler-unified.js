#!/usr/bin/env node
/**
 * install-wake-scheduler-unified.js
 * Universal Wake Scheduler for OpenClaw & ResonantOS
 * 
 * Single codebase that works with:
 * - Vanilla OpenClaw installations
 * - ResonantOS (OpenClaw + infrastructure layer)
 * 
 * Auto-detects environment and installs appropriate scheduler:
 * - Windows: Task Scheduler
 * - macOS: Cron / Launchd
 * - Linux: Cron / Systemd
 * - BSD/Solaris/AIX: Cron
 * - Android (Termux): Cron
 * - Fallback: Node.js watchdog
 * 
 * SECURITY FIXES (v1.2.0-production):
 * - Replaced shell execution with execFile (prevents command injection)
 * - Added path sanitization and XML/PowerShell/Bash escaping
 * - Implemented atomic file creation with secure permissions (0o600/0o700)
 * - Fixed undeclared variables in detectOS
 * - Added WSL/Cygwin detection
 * - Fixed crontab time wrapping bug (2 AM boundary)
 * - Added cleanup on failure for all installers
 * - Resolved symlinks in scriptDir
 * - Added end-to-end verification, watchdog.js, timezone auto-detection
 * - Added config validation, crontab backup, systemd sudo detection
 * - Added log rotation, cleanup helper, pre-flight checks
 * - Multi-model code review: Claude Sonnet 4.5, GPT-4o, Claude Opus
 * 
 * @version 1.2.0-production
 * @license MIT
 * @author Dr. Tom Pennington (Local Doc) assisted by the Real Tom Shady
 * @shoutout Peter Steinberger (OpenClaw) and Manolo Remiddi (ResonantOS)
 * 
 * 🦞 Built with love for the OpenClaw community
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs'); // For realpathSync
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

// Security helper functions
function sanitizePath(p) {
  if (/"|\||&|;|`|\$\(|<|>|\n|\r/.test(p)) {
    throw new Error(`Invalid characters in path: ${p}`);
  }
  return path.resolve(path.normalize(p));
}

function escapeXML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapePowerShell(str) {
  return str.replace(/'/g, "''");
}

function escapeBash(str) {
  return str.replace(/'/g, "'\\''");
}

function sanitizeError(error) {
  console.error('[FULL ERROR]', error);
  return 'Operation failed';
}

// Cleanup helper - removes files on installation failure
async function cleanupFiles(files) {
  for (const file of files) {
    try {
      await fs.unlink(file);
    } catch (error) {
      // Ignore errors (file may not exist or already deleted)
    }
  }
}

// Timezone auto-detection
function detectTimezone() {
  try {
    // Use Intl API to get system timezone
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      return tz;
    }
  } catch (error) {
    // Intl API failed, try environment variable
    if (process.env.TZ) {
      return process.env.TZ;
    }
  }
  
  // Fallback to America/New_York
  return 'America/New_York';
}

// Configuration validation
function validateConfig(config) {
  if (config.wakeInterval <= 0 || config.wakeInterval > 60) {
    throw new Error(`Invalid wakeInterval: ${config.wakeInterval} (must be 1-60 minutes)`);
  }
  if (config.sleepInterval <= 0 || config.sleepInterval > 120) {
    throw new Error(`Invalid sleepInterval: ${config.sleepInterval} (must be 1-120 minutes)`);
  }
  if (config.activeHoursStart < 0 || config.activeHoursStart > 23) {
    throw new Error(`Invalid activeHoursStart: ${config.activeHoursStart} (must be 0-23)`);
  }
  if (config.activeHoursEnd < 0 || config.activeHoursEnd > 23) {
    throw new Error(`Invalid activeHoursEnd: ${config.activeHoursEnd} (must be 0-23)`);
  }
  return true;
}

// Configuration
const CONFIG = Object.freeze({
  wakeInterval: 5, // minutes (during active hours)
  sleepInterval: 15, // minutes (during sleep hours)
  activeHoursStart: 7, // 7 AM
  activeHoursEnd: 2, // 2 AM (next day)
  timezone: detectTimezone(), // Auto-detect system timezone
  scriptDir: fsSync.realpathSync(__dirname), // Resolve symlinks (Fix C10)
  logFile: path.join(__dirname, 'wake-scheduler.log')
});

// Validate configuration
validateConfig(CONFIG);

// Log helper with rotation (Fix #13)
async function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(message);
  
  // Easter egg: 1% chance of developer credit
  if (Math.random() < 0.01) {
    console.log('🦞 Built by Dr. Tom Pennington with love for the OpenClaw community');
  }
  
  try {
    // Check log size and rotate if needed (10MB limit)
    try {
      const stats = await fs.stat(CONFIG.logFile);
      if (stats.size > 10 * 1024 * 1024) { // 10MB
        // Rotate log file
        const rotatedPath = `${CONFIG.logFile}.1`;
        await fs.rename(CONFIG.logFile, rotatedPath).catch(() => {
          // If rotation fails, truncate the log instead
          return fs.writeFile(CONFIG.logFile, '');
        });
      }
    } catch (error) {
      // Log file doesn't exist yet, will be created on appendFile
    }
    
    await fs.appendFile(CONFIG.logFile, logLine);
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }
}

// Detect OpenClaw vs ResonantOS
async function detectEnvironment() {
  let isResonantOS = false;
  let openclawPath = null;
  
  try {
    // Check for ResonantOS markers
    const homeDir = os.homedir();
    const resonantMarkers = [
      path.join(homeDir, '.resonantos'),
      path.join(homeDir, '.openclaw', 'resonant.lock'),
      '/etc/resonantos'
    ];
    
    for (const marker of resonantMarkers) {
      try {
        await fs.access(marker);
        isResonantOS = true;
        await log('Detected ResonantOS environment');
        break;
      } catch {
        // Marker doesn't exist, continue
      }
    }
    
    // Find openclaw CLI path
    try {
      const isWindows = os.platform() === 'win32';
      const command = isWindows ? 'where' : 'which';
      const { stdout } = await execFileAsync(command, ['openclaw'], {
        windowsHide: true
      });
      openclawPath = stdout.trim();
    } catch {
      // Try common paths
      const commonPaths = [
        '/usr/local/bin/openclaw',
        '/usr/bin/openclaw',
        path.join(homeDir, '.local', 'bin', 'openclaw'),
        'C:\\Program Files\\openclaw\\openclaw.exe',
        'C:\\Users\\' + os.userInfo().username + '\\AppData\\Roaming\\npm\\openclaw.cmd'
      ];
      
      for (const testPath of commonPaths) {
        try {
          await fs.access(testPath);
          openclawPath = testPath;
          break;
        } catch {
          continue;
        }
      }
    }
    
    if (!openclawPath) {
      await log('⚠️ openclaw CLI not found in PATH');
      openclawPath = 'openclaw'; // Fallback, may not work
    } else {
      await log(`Found openclaw at: ${openclawPath}`);
    }
  } catch (error) {
    await log(`Environment detection warning: ${error.message}`);
  }
  
  return {
    isResonantOS,
    isOpenClaw: !isResonantOS,
    openclawPath: openclawPath || 'openclaw',
    stack: isResonantOS ? 'ResonantOS/OpenClaw' : 'OpenClaw'
  };
}

// Comprehensive OS detection
async function detectOS() {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  
  let osType = 'unknown';
  let hasCron = false;
  let hasSystemd = false;
  let hasLaunchd = false;
  let hasTaskScheduler = false;
  let isTermux = false;
  let isWSL = false;
  let isCygwin = false;
  
  // WSL detection (Fix C4)
  if (platform === 'linux') {
    isWSL = release.toLowerCase().includes('microsoft') ||
            release.toLowerCase().includes('wsl');
    
    if (!isWSL) {
      try {
        await fs.access('/proc/sys/fs/binfmt_misc/WSLInterop');
        isWSL = true;
      } catch {}
    }
    
    isCygwin = process.env.CYGWIN !== undefined;
  }
  
  if (platform === 'win32') {
    osType = 'Windows';
    hasTaskScheduler = true;
  } else if (platform === 'darwin') {
    osType = 'macOS';
    hasCron = true;
    hasLaunchd = true;
  } else if (platform === 'linux') {
    const isAndroid = release.toLowerCase().includes('android') || 
                     process.env.TERMUX_VERSION !== undefined;
    
    if (isAndroid) {
      osType = 'Android (Termux)';
      isTermux = true;
      hasCron = true;
    } else {
      osType = 'Linux';
      hasCron = true;
      try {
        const { execSync } = require('child_process');
        execSync('systemctl --version', { stdio: 'ignore' });
        hasSystemd = true;
      } catch {
        hasSystemd = false;
      }
    }
  } else if (platform === 'freebsd' || platform === 'openbsd' || platform === 'netbsd') {
    osType = `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
    hasCron = true;
  } else if (platform === 'sunos') {
    osType = 'Solaris/Illumos';
    hasCron = true;
  } else if (platform === 'aix') {
    osType = 'AIX';
    hasCron = true;
  }
  
  log(`Detected OS: ${osType} (${platform}/${arch}), Release: ${release}`);
  log(`Capabilities: cron=${hasCron}, systemd=${hasSystemd}, launchd=${hasLaunchd}, taskScheduler=${hasTaskScheduler}`);
  
  return {
    isWindows: platform === 'win32',
    isLinux: platform === 'linux',
    isMacOS: platform === 'darwin',
    isFreeBSD: platform === 'freebsd',
    isOpenBSD: platform === 'openbsd',
    isNetBSD: platform === 'netbsd',
    isBSD: platform.includes('bsd'),
    isSolaris: platform === 'sunos',
    isAIX: platform === 'aix',
    isTermux,
    isWSL,
    isCygwin,
    platform,
    arch,
    release,
    osType,
    hasCron,
    hasSystemd,
    hasLaunchd,
    hasTaskScheduler
  };
}

// Create Windows Task Scheduler XML (Fix C1, C5)
function createWindowsTaskXML(openclawPath) {
  const username = os.userInfo().username;
  
  // Use secure directory with random filename
  const safeScriptDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'OpenClaw', 'tasks');
  const scriptName = `wake_${crypto.randomBytes(8).toString('hex')}.ps1`;
  const scriptPath = path.join(safeScriptDir, scriptName);
  
  // Sanitize and escape
  const escapedScriptPath = escapeXML(sanitizePath(scriptPath));
  const escapedUsername = escapeXML(username);
  
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OpenClaw/ResonantOS wake scheduler - keeps agent responsive</Description>
    <Author>${escapedUsername}</Author>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <Repetition>
        <Interval>PT${CONFIG.wakeInterval}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${new Date().toISOString().split('T')[0]}T07:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
    <CalendarTrigger>
      <Repetition>
        <Interval>PT${CONFIG.sleepInterval}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${new Date().toISOString().split('T')[0]}T02:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-ExecutionPolicy RemoteSigned -NoProfile -File "${escapedScriptPath}"</Arguments>
    </Exec>
  </Actions>
  <Principals>
    <Principal id="Author">
      <UserId>${escapedUsername}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
</Task>`;
  
  return {
    xml,
    scriptPath,
    scriptDir: safeScriptDir
  };
}

// Install Windows scheduled task (Fix C6, C7, C2)
async function installWindows(env) {
  const createdFiles = [];
  try {
    log('Installing Windows Task Scheduler entry...');
    
    // Generate task XML with secure paths
    const taskInfo = createWindowsTaskXML(env.openclawPath);
    const psScriptPath = taskInfo.scriptPath;
    const scriptDir = taskInfo.scriptDir;
    
    // Create secure directory
    await fs.mkdir(scriptDir, { recursive: true, mode: 0o700 });
    
    // Secure PowerShell script with proper escaping (Fix C6)
    const psScript = `#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

param([string]$Message = "Scheduled wake pulse")

$openclawPath = '${escapePowerShell(env.openclawPath)}'
if (-not (Test-Path -LiteralPath $openclawPath -PathType Leaf)) {
    Write-Error "OpenClaw executable not found"
    exit 1
}

& $openclawPath wake --text $Message
`;
    
    // Atomic file creation with secure permissions (Fix C7)
    const psFd = await fs.open(psScriptPath, 'wx', 0o700);
    try {
      await psFd.writeFile(psScript, 'utf8');
    } finally {
      await psFd.close();
    }
    createdFiles.push(psScriptPath);
    log(`✓ Created ${psScriptPath}`);
    
    const xmlPath = path.join(scriptDir, 'openclaw-wake-task.xml');
    const xmlFd = await fs.open(xmlPath, 'wx', 0o600);
    try {
      // UTF-16LE with BOM (required for Windows Task Scheduler)
      const BOM = Buffer.from([0xFF, 0xFE]);
      const xmlBuffer = Buffer.concat([BOM, Buffer.from(taskInfo.xml, 'utf16le')]);
      await xmlFd.writeFile(xmlBuffer);
    } finally {
      await xmlFd.close();
    }
    createdFiles.push(xmlPath);
    log(`✓ Created task XML: ${xmlPath}`);
    
    // Use execFile instead of execAsync (Fix C2)
    try {
      await execFileAsync('schtasks', ['/query', '/tn', 'OpenClaw\\LocalDocWake'], { windowsHide: true });
      log('Task already exists, deleting old version...');
      await execFileAsync('schtasks', ['/delete', '/tn', 'OpenClaw\\LocalDocWake', '/f'], { windowsHide: true });
    } catch {
      // Task doesn't exist
    }
    
    await execFileAsync('schtasks', ['/create', '/tn', 'OpenClaw\\LocalDocWake', '/xml', xmlPath], { windowsHide: true });
    log('✅ Windows scheduled task installed successfully');
    
    const { stdout } = await execFileAsync('schtasks', ['/query', '/tn', 'OpenClaw\\LocalDocWake', '/fo', 'LIST'], { windowsHide: true });
    log('Task details:');
    log(stdout);
    
    // Platform-specific warning
    log('');
    log('⚠️  Note: Task may require admin approval on first run');
    log('    If the task doesn\'t execute, check Task Scheduler for permission prompts');
    
    return true;
  } catch (error) {
    log(`❌ Windows installation failed: ${error.message}`);
    await cleanupFiles(createdFiles);
    return false;
  }
}

// Create crontab entries (Fix C8 - time wrapping)
function createCrontabEntries(scriptPath) {
  // Unique marker for idempotency
  const MARKER = '# openclaw-wake-scheduler-v1.2.0';
  
  return `
${MARKER}
# Active hours (7 AM - 2:59 AM): every 5 minutes
*/5 7-23 * * * ${scriptPath} "Scheduled wake pulse" >> ${CONFIG.logFile} 2>&1
*/5 0-2 * * * ${scriptPath} "Scheduled wake pulse" >> ${CONFIG.logFile} 2>&1

# Sleep hours (3 AM - 6:59 AM): every 15 minutes
*/15 3-6 * * * ${scriptPath} "Scheduled wake pulse" >> ${CONFIG.logFile} 2>&1
`;
}

// Install Unix cron job (Fix C9 - secure Unix installation)
async function installUnix(env) {
  const createdFiles = [];
  try {
    log('Installing cron job...');
    
    const shScriptPath = path.join(CONFIG.scriptDir, 'wake_doc.sh');
    const shScript = `#!/bin/bash
# wake_doc.sh
# Auto-generated for ${env.stack}
set -euo pipefail
MESSAGE="\${1:-Scheduled wake pulse}"
'${escapeBash(env.openclawPath)}' wake --text "$MESSAGE"
`;
    
    // Atomic file creation with secure permissions
    const shFd = await fs.open(shScriptPath, 'wx', 0o700);
    try {
      await shFd.writeFile(shScript, 'utf8');
    } finally {
      await shFd.close();
    }
    createdFiles.push(shScriptPath);
    log(`✓ Created ${shScriptPath}`);
    
    let currentCrontab = '';
    try {
      const { stdout } = await execFileAsync('crontab', ['-l'], { windowsHide: true });
      currentCrontab = stdout;
      
      // Backup existing crontab before modification
      if (currentCrontab) {
        const backupPath = path.join(os.homedir(), '.crontab.backup');
        await fs.writeFile(backupPath, currentCrontab, 'utf8');
        log(`✓ Crontab backed up to: ${backupPath}`);
      }
    } catch {
      log('No existing crontab found (creating new)');
    }
    
    // Remove old entries (idempotent - look for marker or keywords)
    const MARKER = 'openclaw-wake-scheduler';
    if (currentCrontab.includes(MARKER) || currentCrontab.includes('wake_doc.sh')) {
      log('Removing old wake scheduler entries...');
      const lines = currentCrontab.split('\n');
      const filtered = [];
      let skipNext = false;
      
      for (const line of lines) {
        // Skip lines with marker or openclaw/wake_doc references
        if (line.includes(MARKER)) {
          skipNext = true; // Skip marker and following entries
          continue;
        }
        if (skipNext && (line.includes('wake_doc.sh') || line.includes('openclaw'))) {
          continue; // Skip scheduler entries
        }
        if (!line.includes('wake_doc.sh')) {
          skipNext = false; // Reset when we hit non-scheduler line
        }
        filtered.push(line);
      }
      
      currentCrontab = filtered.join('\n');
    }
    
    const newCrontab = currentCrontab.trim() + '\n' + createCrontabEntries(shScriptPath);
    
    // Secure tempfile with crypto-random name
    const tempFileName = `openclaw-crontab-${crypto.randomBytes(8).toString('hex')}`;
    const tempFile = path.join(os.tmpdir(), tempFileName);
    const tempFd = await fs.open(tempFile, 'wx', 0o600);
    try {
      await tempFd.writeFile(newCrontab, 'utf8');
    } finally {
      await tempFd.close();
    }
    createdFiles.push(tempFile);
    
    await execFileAsync('crontab', [tempFile], { windowsHide: true });
    await fs.unlink(tempFile);
    createdFiles.pop(); // Remove from cleanup list (successfully processed)
    
    log('✅ Cron job installed successfully');
    
    const { stdout } = await execFileAsync('crontab', ['-l'], { windowsHide: true });
    log('Current crontab:');
    log(stdout);
    
    // Platform-specific info
    log('');
    log('ℹ️  Cron job will run automatically based on schedule');
    log('   Check logs at: ' + CONFIG.logFile);
    
    return true;
  } catch (error) {
    log(`❌ Unix installation failed: ${error.message}`);
    // Don't cleanup wake script - fallback installers (systemd/launchd) need it
    // Only cleanup temp crontab file
    const tempFiles = createdFiles.filter(f => f.includes('openclaw-crontab-'));
    await cleanupFiles(tempFiles);
    return false;
  }
}

// Systemd timer installation (Fix C2)
async function installSystemd(env) {
  const createdFiles = [];
  try {
    // Check if we have root/sudo privileges
    if (process.getuid && process.getuid() !== 0) {
      log('⚠️  Systemd requires root/sudo privileges');
      log('    Skipping systemd, will use cron instead');
      log('    To use systemd, run: sudo node install-wake-scheduler-unified.js');
      return false;
    }
    
    log('Installing systemd timer...');
    
    const serviceName = 'openclaw-wake';
    const serviceFile = `/etc/systemd/system/${serviceName}.service`;
    const timerFile = `/etc/systemd/system/${serviceName}.timer`;
    
    const scriptPath = path.join(CONFIG.scriptDir, 'wake_doc.sh');
    
    const serviceContent = `[Unit]
Description=OpenClaw/ResonantOS Wake Service
After=network.target

[Service]
Type=oneshot
ExecStart=${scriptPath} "Systemd wake pulse"
StandardOutput=append:${CONFIG.logFile}
StandardError=append:${CONFIG.logFile}

[Install]
WantedBy=multi-user.target
`;

    const timerContent = `[Unit]
Description=OpenClaw/ResonantOS Wake Timer
Requires=${serviceName}.service

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=1s

[Install]
WantedBy=timers.target
`;

    await fs.writeFile(serviceFile, serviceContent, 'utf8');
    createdFiles.push(serviceFile);
    await fs.writeFile(timerFile, timerContent, 'utf8');
    createdFiles.push(timerFile);
    
    await execFileAsync('systemctl', ['daemon-reload'], { windowsHide: true });
    await execFileAsync('systemctl', ['enable', `${serviceName}.timer`], { windowsHide: true });
    await execFileAsync('systemctl', ['start', `${serviceName}.timer`], { windowsHide: true });
    
    log('✅ Systemd timer installed successfully');
    
    const { stdout } = await execFileAsync('systemctl', ['status', `${serviceName}.timer`], { windowsHide: true });
    log('Timer status:');
    log(stdout);
    
    // Platform-specific warning
    log('');
    log('⚠️  Note: Systemd timer installed (requires root/sudo)');
    log('    Timer runs as system service');
    log('    Check status with: systemctl status openclaw-wake.timer');
    
    return true;
  } catch (error) {
    log(`❌ Systemd installation failed: ${error.message}`);
    log('Note: Systemd installation requires root/sudo privileges');
    await cleanupFiles(createdFiles);
    return false;
  }
}

// Launchd plist installation (Fix C1, C2)
async function installLaunchd(env) {
  const createdFiles = [];
  try {
    log('Installing launchd agent...');
    
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.wake.plist');
    const scriptPath = path.join(CONFIG.scriptDir, 'wake_doc.sh');
    
    // XML escape paths
    const escapedScriptPath = escapeXML(scriptPath);
    const escapedLogFile = escapeXML(CONFIG.logFile);
    
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.wake</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapedScriptPath}</string>
        <string>Launchd wake pulse</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapedLogFile}</string>
    <key>StandardErrorPath</key>
    <string>${escapedLogFile}</string>
</dict>
</plist>
`;

    const launchAgentsDir = path.dirname(plistPath);
    await fs.mkdir(launchAgentsDir, { recursive: true });
    
    await fs.writeFile(plistPath, plistContent, 'utf8');
    createdFiles.push(plistPath);
    
    await execFileAsync('launchctl', ['load', plistPath], { windowsHide: true });
    
    log('✅ Launchd agent installed successfully');
    
    const { stdout } = await execFileAsync('sh', ['-c', 'launchctl list | grep openclaw'], { windowsHide: true });
    log('Agent status:');
    log(stdout);
    
    // Platform-specific warning
    log('');
    log('⚠️  Note: macOS may require approval for launch agents');
    log('    If the agent doesn\'t run, check:');
    log('    System Preferences > Security & Privacy > Privacy > Full Disk Access');
    log('    System Preferences > Security & Privacy > General (for approval prompts)');
    
    return true;
  } catch (error) {
    log(`❌ Launchd installation failed: ${error.message}`);
    await cleanupFiles(createdFiles);
    return false;
  }
}

// Pre-flight checks - verify schedulers are available before installation
async function preflightChecks(osInfo) {
  const checks = [];
  
  if (osInfo.hasTaskScheduler) {
    try {
      await execFileAsync('schtasks', ['/query'], { windowsHide: true, timeout: 5000 });
      checks.push({ name: 'Windows Task Scheduler', status: '✅ Available' });
    } catch (error) {
      checks.push({ name: 'Windows Task Scheduler', status: '❌ Unavailable', error: error.message });
    }
  }
  
  if (osInfo.hasCron) {
    try {
      await execFileAsync('crontab', ['-l'], { windowsHide: true, timeout: 5000 });
      checks.push({ name: 'Cron', status: '✅ Available' });
    } catch (error) {
      // Exit code 1 with "no crontab" is actually OK (means cron exists, just no entries yet)
      if (error.message.includes('no crontab')) {
        checks.push({ name: 'Cron', status: '✅ Available (no existing entries)' });
      } else {
        checks.push({ name: 'Cron', status: '❌ Unavailable', error: error.message });
      }
    }
  }
  
  if (osInfo.hasSystemd) {
    try {
      await execFileAsync('systemctl', ['--version'], { windowsHide: true, timeout: 5000 });
      checks.push({ name: 'Systemd', status: '✅ Available' });
    } catch (error) {
      checks.push({ name: 'Systemd', status: '❌ Unavailable', error: error.message });
    }
  }
  
  if (osInfo.hasLaunchd) {
    try {
      await execFileAsync('launchctl', ['list'], { windowsHide: true, timeout: 5000 });
      checks.push({ name: 'Launchd', status: '✅ Available' });
    } catch (error) {
      checks.push({ name: 'Launchd', status: '❌ Unavailable', error: error.message });
    }
  }
  
  return checks;
}

// Post-install verification - tests that openclaw wake actually works
async function verifyInstallation(env) {
  try {
    await log('Running post-install verification...');
    const { stdout, stderr } = await execFileAsync(
      env.openclawPath,
      ['wake', '--text', 'Installation verification test'],
      { timeout: 10000, windowsHide: true }
    );
    const output = stdout.trim();
    if (output) {
      await log(`✅ Verification successful: ${output}`);
    } else {
      await log('✅ Verification successful (wake command executed)');
    }
    return true;
  } catch (error) {
    await log(`⚠️ Verification failed: ${error.message}`);
    await log('The scheduler is installed but openclaw wake may not be working.');
    await log('Possible causes:');
    await log('  - OpenClaw gateway is not running');
    await log('  - openclaw CLI path is incorrect');
    await log('  - Network/permission issues');
    await log('The scheduler will still attempt to send wake signals.');
    return false;
  }
}

// Fallback: Node.js watchdog
async function fallbackWatchdog(env) {
  try {
    log('⚠️ OS-level scheduling failed, starting Node.js watchdog fallback...');
    
    const watchdogPath = path.join(CONFIG.scriptDir, 'watchdog.js');
    
    try {
      await fs.access(watchdogPath);
    } catch {
      log('❌ watchdog.js not found, cannot start fallback');
      return false;
    }
    
    const { spawn } = require('child_process');
    const child = spawn('node', [watchdogPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    
    log(`✅ Watchdog fallback started (PID: ${child.pid})`);
    return true;
  } catch (error) {
    log(`❌ Fallback watchdog failed: ${error.message}`);
    return false;
  }
}

// Version conflict detection
async function checkVersionConflict() {
  const versionFile = path.join(os.homedir(), '.openclaw-wake-scheduler-version');
  const currentVersion = '1.2.0-production';
  
  try {
    const installedVersion = await fs.readFile(versionFile, 'utf8');
    const installed = installedVersion.trim();
    
    if (installed) {
      await log(`Detected existing installation: ${installed}`);
      
      // Simple version comparison (newer versions have higher numbers)
      if (installed > currentVersion) {
        await log(`⚠️  WARNING: Installed version (${installed}) is newer than current (${currentVersion})`);
        await log('    This may be a downgrade.');
        await log('    Proceeding in 5 seconds... (Ctrl+C to cancel)');
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else if (installed === currentVersion) {
        await log(`Reinstalling ${currentVersion}`);
      } else {
        await log(`Upgrading ${installed} → ${currentVersion}`);
      }
    }
  } catch (error) {
    // No version file, first install
    await log('First installation detected');
  }
  
  // Write new version
  try {
    await fs.writeFile(versionFile, currentVersion, 'utf8');
  } catch (error) {
    // Non-critical if version file write fails
  }
}

// Main installation flow
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('   OpenClaw/ResonantOS Wake Scheduler');
  console.log('   Universal Multi-Platform Installer');
  console.log('═══════════════════════════════════════════════\n');
  
  await log('Starting installation...');
  
  // Check for version conflicts
  await checkVersionConflict();
  
  // Detect environment
  const env = await detectEnvironment();
  await log(`Environment: ${env.stack}`);
  
  // Detect OS
  const osInfo = await detectOS();
  
  // Run pre-flight checks
  await log('Running pre-flight checks...');
  const checks = await preflightChecks(osInfo);
  for (const check of checks) {
    await log(`  ${check.name}: ${check.status}`);
  }
  
  let success = false;
  let method = 'unknown';
  
  // Install based on OS capabilities
  if (osInfo.isWindows) {
    method = 'Task Scheduler';
    success = await installWindows(env);
  } else if (osInfo.hasCron) {
    method = 'Cron';
    success = await installUnix(env);
    
    if (!success) {
      if (osInfo.hasSystemd && !osInfo.isTermux) {
        method = 'Systemd Timer';
        await log('Cron failed, trying systemd...');
        success = await installSystemd(env);
      }
      
      if (!success && osInfo.hasLaunchd) {
        method = 'Launchd';
        await log('Trying launchd...');
        success = await installLaunchd(env);
      }
    }
  } else {
    await log(`⚠️ No native scheduler found for ${osInfo.osType}`);
  }
  
  // Fallback to watchdog if OS-level scheduling failed
  if (!success) {
    method = 'Node.js Watchdog (fallback)';
    await log('All native methods failed, attempting fallback...');
    success = await fallbackWatchdog(env);
  }
  
  // Verify installation (if successful)
  let verified = false;
  if (success) {
    verified = await verifyInstallation(env);
  }
  
  // Final status
  console.log('\n═══════════════════════════════════════════════');
  if (success) {
    await log(`✅ Installation complete - wake scheduler active (${method})`);
    console.log('✅ Installation complete!');
    console.log(`Environment: ${env.stack}`);
    console.log(`Method: ${method}`);
    console.log(`Verification: ${verified ? '✅ Passed' : '⚠️ Failed (see log)'}`);
    console.log(`Log file: ${CONFIG.logFile}`);
  } else {
    await log('❌ Installation failed - manual setup required');
    console.log('❌ Installation failed');
    console.log('Check log file for details:', CONFIG.logFile);
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════════');
}

// Run installer
if (require.main === module) {
  main().catch(async (error) => {
    await log(`FATAL ERROR: ${error.message}`);
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { detectEnvironment, detectOS, installWindows, installUnix, installSystemd, installLaunchd, fallbackWatchdog };
