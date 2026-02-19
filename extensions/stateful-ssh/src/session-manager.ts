import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { Client, ClientChannel } from "ssh2";

export interface SSHSessionConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SSHSession {
  id: string;
  config: SSHSessionConfig;
  client: Client;
  shell: ClientChannel;
  lastActivity: number;
  buffer: string;
  promptPattern: RegExp;
  commandQueue: Promise<void>;
}

export interface SSHSessionManagerOptions {
  maxSessions?: number;
  sessionTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class SSHSessionManager {
  private sessions: Map<string, SSHSession> = new Map();
  private readonly maxSessions: number;
  private readonly sessionTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(options: SSHSessionManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? 5;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 600000; // 10 minutes
    this.commandTimeoutMs = options.commandTimeoutMs ?? 300000; // 5 minutes

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, 60000); // Check every minute
  }

  /**
   * Parses ~/.ssh/config to find the IdentityFile for a given host.
   * Supports Host patterns and HostName directives.
   */
  private async findKeyFromSSHConfig(host: string): Promise<string | null> {
    const sshConfigPath = `${homedir()}/.ssh/config`;

    try {
      const configContent = await readFile(sshConfigPath, "utf-8");
      const lines = configContent.split("\n");

      let currentHostPatterns: string[] = [];
      let currentHostName: string | null = null;
      let identityFile: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip comments and empty lines
        if (trimmed.startsWith("#") || trimmed === "") {
          continue;
        }

        // Parse "Host" directive
        const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
        if (hostMatch) {
          // Check if previous host matched and had an IdentityFile
          if (
            currentHostPatterns.length > 0 &&
            identityFile &&
            this.matchesAnyHostPattern(host, currentHostPatterns, currentHostName)
          ) {
            return await this.expandAndReadKey(identityFile);
          }

          // Start new host block - split multiple patterns by whitespace
          const patternsString = hostMatch[1].trim();
          currentHostPatterns = patternsString.split(/\s+/);
          currentHostName = null;
          identityFile = null;
          continue;
        }

        // Parse "HostName" directive
        const hostNameMatch = trimmed.match(/^HostName\s+(.+)$/i);
        if (hostNameMatch && currentHostPatterns.length > 0) {
          currentHostName = hostNameMatch[1].trim();
          continue;
        }

        // Parse "IdentityFile" directive
        const identityMatch = trimmed.match(/^IdentityFile\s+(.+)$/i);
        if (identityMatch && currentHostPatterns.length > 0) {
          identityFile = identityMatch[1].trim();
          continue;
        }
      }

      // Check last host block
      if (
        currentHostPatterns.length > 0 &&
        identityFile &&
        this.matchesAnyHostPattern(host, currentHostPatterns, currentHostName)
      ) {
        return await this.expandAndReadKey(identityFile);
      }

      console.log(`[SSH] No matching host found in ${sshConfigPath} for ${host}`);
      return null;
    } catch (error) {
      // Config file doesn't exist or not readable
      console.log(
        `[SSH] Could not read ${sshConfigPath}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  /**
   * Checks if the given host matches any of the Host patterns or HostName.
   * SSH config allows multiple patterns in one Host line: "Host pattern1 pattern2 pattern3"
   */
  private matchesAnyHostPattern(
    targetHost: string,
    hostPatterns: string[],
    hostName: string | null,
  ): boolean {
    // Check each Host pattern
    for (const pattern of hostPatterns) {
      // Direct match with Host pattern
      if (targetHost === pattern) {
        return true;
      }

      // Support wildcard patterns (escape regex metacharacters, then expand *)
      if (pattern.includes("*")) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
        const regex = new RegExp("^" + escaped + "$");
        if (regex.test(targetHost)) {
          return true;
        }
      }
    }

    // Match with HostName if specified
    if (hostName && targetHost === hostName) {
      return true;
    }

    return false;
  }

  /**
   * Expands path variables and reads the key file.
   */
  private async expandAndReadKey(keyPath: string): Promise<string | null> {
    // Expand ~ to home directory
    let expandedPath = keyPath.replace(/^~/, homedir());

    // Expand $HOME or ${HOME}
    expandedPath = expandedPath.replace(/\$HOME|\$\{HOME\}/g, homedir());

    try {
      await access(expandedPath, constants.R_OK);
      const keyContent = await readFile(expandedPath, "utf-8");
      console.log(`[SSH] Found SSH key from config: ${expandedPath}`);
      return keyContent;
    } catch (error) {
      console.log(
        `[SSH] Could not read key file ${expandedPath}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  /**
   * Searches for default SSH private keys in the standard locations.
   * Mimics SSH client behavior by checking common key filenames.
   */
  private async findDefaultPrivateKey(): Promise<string | null> {
    const sshDir = `${homedir()}/.ssh`;

    // Standard SSH key filenames, in order of preference
    const keyFilenames = [
      "bot_key", // Our custom bot key
      "id_ed25519", // Modern, recommended
      "id_ecdsa", // ECDSA
      "id_rsa", // Classic RSA
      "id_dsa", // Legacy (deprecated but still checked)
    ];

    for (const filename of keyFilenames) {
      const keyPath = `${sshDir}/${filename}`;
      try {
        // Check if file exists and is readable
        await access(keyPath, constants.R_OK);
        // Read the key content
        const keyContent = await readFile(keyPath, "utf-8");
        console.log(`[SSH] Found default private key: ${keyPath}`);
        return keyContent;
      } catch {
        // File doesn't exist or not readable, continue to next
        continue;
      }
    }

    console.log(`[SSH] No default private key found in ${sshDir}`);
    return null;
  }

  async openSession(config: SSHSessionConfig): Promise<string> {
    // Check session limit
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Maximum number of sessions (${this.maxSessions}) reached. Please close existing sessions.`,
      );
    }

    // Auto-detect SSH key if no authentication method provided
    if (!config.password && !config.privateKey) {
      console.log(
        `[SSH] No authentication provided, searching for SSH key for host: ${config.host}`,
      );

      // 1. First, try to find key from ~/.ssh/config
      let detectedKey = await this.findKeyFromSSHConfig(config.host);

      // 2. If not found in config, fall back to standard key locations
      if (!detectedKey) {
        console.log("[SSH] No match in SSH config, trying default key locations...");
        detectedKey = await this.findDefaultPrivateKey();
      }

      if (detectedKey) {
        config.privateKey = detectedKey;
        console.log("[SSH] Using automatically detected SSH key");
      } else {
        throw new Error(
          `No authentication method provided for ${config.host}. Either provide a password, privateKey, or configure the host in ~/.ssh/config, or ensure a default SSH key exists in ~/.ssh/`,
        );
      }
    }

    const sessionId = randomUUID().substring(0, 8);
    const client = new Client();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error("SSH connection timeout"));
      }, this.commandTimeoutMs);

      client.on("ready", () => {
        clearTimeout(timeout);

        client.shell((err, stream) => {
          if (err) {
            client.end();
            reject(new Error(`Failed to open shell: ${err.message}`));
            return;
          }

          let buffer = "";
          const promptPattern = /[\$#>]\s*$/; // Common shell prompts

          stream.on("data", (data: Buffer) => {
            buffer += data.toString();
          });

          // Wait for initial prompt
          const promptTimeout = setTimeout(() => {
            clearInterval(checkPrompt);
            client.end();
            reject(new Error("Timeout waiting for shell prompt"));
          }, 5000);

          const checkPrompt = setInterval(() => {
            if (promptPattern.test(buffer)) {
              clearInterval(checkPrompt);
              clearTimeout(promptTimeout);

              const session: SSHSession = {
                id: sessionId,
                config,
                client,
                shell: stream,
                lastActivity: Date.now(),
                buffer: "",
                promptPattern,
                commandQueue: Promise.resolve(),
              };

              this.sessions.set(sessionId, session);
              resolve(sessionId);
            }
          }, 100);

          // Cleanup timers if stream fails before prompt is detected
          stream.once("error", (err: Error) => {
            clearInterval(checkPrompt);
            clearTimeout(promptTimeout);
            client.end();
            reject(new Error(`Shell stream error: ${err.message}`));
          });

          stream.once("close", () => {
            clearInterval(checkPrompt);
            clearTimeout(promptTimeout);
            reject(new Error("Shell stream closed unexpectedly"));
          });
        });
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      // Connect with the provided configuration
      const connectConfig: any = {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
      };

      if (config.password) {
        connectConfig.password = config.password;
      }

      if (config.privateKey) {
        connectConfig.privateKey = config.privateKey;
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase;
        }
      }

      client.connect(connectConfig);
    });
  }

  async executeCommand(sessionId: string, command: string, timeoutMs?: number): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Wait for previous command to finish
    await session.commandQueue;

    // Execute this command and update the queue
    const commandPromise = this.executeCommandInternal(session, command, timeoutMs);
    session.commandQueue = commandPromise.then(
      () => {},
      () => {},
    ); // Swallow errors to not block queue

    return commandPromise;
  }

  private async executeCommandInternal(
    session: SSHSession,
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    session.lastActivity = Date.now();
    session.buffer = "";

    return new Promise((resolve, reject) => {
      let checkInterval: NodeJS.Timeout | undefined;

      const errorHandler = (err: Error) => {
        cleanup();
        reject(new Error(`Shell stream error during command execution: ${err.message}`));
      };

      const closeHandler = () => {
        cleanup();
        reject(
          new Error(
            "Shell stream closed unexpectedly during command execution. The SSH server may have an idle timeout.",
          ),
        );
      };

      const cleanup = () => {
        if (checkInterval) clearInterval(checkInterval);
        clearTimeout(timeout);
        session.shell.removeListener("data", dataHandler);
        session.shell.removeListener("error", errorHandler);
        session.shell.removeListener("close", closeHandler);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Command execution timeout"));
      }, timeoutMs ?? this.commandTimeoutMs);

      // Listen for data
      const dataHandler = (data: Buffer) => {
        session.buffer += data.toString();
      };
      session.shell.on("data", dataHandler);

      // Listen for errors or premature close
      session.shell.once("error", errorHandler);
      session.shell.once("close", closeHandler);

      // Send command
      session.shell.write(`${command}\n`);

      // Wait for prompt to appear again
      checkInterval = setInterval(() => {
        if (session.promptPattern.test(session.buffer)) {
          cleanup();

          // Clean up the output
          let output = session.buffer;

          // Remove the command echo (first line)
          const lines = output.split("\n");
          if (lines.length > 0 && lines[0].trim() === command.trim()) {
            lines.shift();
          }

          // Remove the prompt from the last line
          if (lines.length > 0) {
            lines[lines.length - 1] = lines[lines.length - 1].replace(session.promptPattern, "");
          }

          output = lines.join("\n").trim();
          resolve(output);
        }
      }, 100);
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve) => {
      session.client.on("close", () => {
        this.sessions.delete(sessionId);
        resolve();
      });

      session.shell.end();
      session.client.end();
    });
  }

  getSession(sessionId: string): SSHSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Array<{ id: string; host: string; username: string; lastActivity: number }> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      host: session.config.host,
      username: session.config.username,
      lastActivity: session.lastActivity,
    }));
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTimeoutMs) {
        console.log(`Cleaning up idle session: ${sessionId}`);
        this.closeSession(sessionId).catch((err) => {
          console.error(`Error closing idle session ${sessionId}:`, err);
        });
      }
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    const closePromises = Array.from(this.sessions.keys()).map((sessionId) =>
      this.closeSession(sessionId).catch((err) => {
        console.error(`Error closing session ${sessionId}:`, err);
      }),
    );

    await Promise.all(closePromises);
  }
}
