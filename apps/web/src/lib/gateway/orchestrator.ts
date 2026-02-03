import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Bot } from '@/payload-types'

export interface GatewayProcess {
  botId: string
  process: ChildProcess
  port: number
  pid: number
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  startTime: Date
  errorMessage?: string
}

export interface GatewayConfig {
  basePath: string
  basePort: number
  maxBots: number
  openclawBinaryPath?: string
}

/**
 * Gateway Orchestrator manages multiple OpenClaw gateway processes
 * Each bot runs in its own isolated process with dedicated config
 */
export class GatewayOrchestrator extends EventEmitter {
  private processes = new Map<string, GatewayProcess>()
  private config: GatewayConfig
  private portAllocation = new Map<string, number>()

  constructor(config: GatewayConfig) {
    super()
    this.config = {
      basePath: config.basePath || '/var/openclaw',
      basePort: config.basePort || 18789,
      maxBots: config.maxBots || 50,
      openclawBinaryPath: config.openclawBinaryPath || 'openclaw'
    }
  }

  /**
   * Start a bot gateway
   */
  async startBot(bot: Bot): Promise<void> {
    const botId = typeof bot === 'string' ? bot : bot.agentId

    // Check if already running
    if (this.processes.has(botId)) {
      const existing = this.processes.get(botId)
      if (existing?.status === 'running') {
        throw new Error(`Bot ${botId} is already running`)
      }
    }

    // Allocate port
    const port = this.allocatePort(botId)

    // Generate config
    const configPath = await this.generateBotConfig(bot, port)

    // Start process
    const openclawPath = this.config.openclawBinaryPath || 'openclaw'
    const args = [
      'gateway',
      'run',
      '--config',
      configPath,
      '--port',
      String(port),
      '--bind',
      'loopback',
      '--force'
    ]

    const process = spawn(openclawPath, args, {
      cwd: this.getBotDirectory(botId),
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SESSION_PATH: join(this.getBotDirectory(botId), 'sessions.json')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    // Track process
    const gatewayProcess: GatewayProcess = {
      botId,
      process,
      port,
      pid: process.pid!,
      status: 'starting',
      startTime: new Date()
    }

    this.processes.set(botId, gatewayProcess)

    // Set up event handlers
    process.stdout?.on('data', (data) => {
      const output = data.toString()
      this.emit('log', { botId, level: 'info', message: output })

      // Detect when gateway is ready
      if (output.includes('Gateway listening')) {
        gatewayProcess.status = 'running'
        this.emit('started', { botId, port, pid: process.pid })
      }
    })

    process.stderr?.on('data', (data) => {
      const output = data.toString()
      this.emit('log', { botId, level: 'error', message: output })
    })

    process.on('error', (error) => {
      gatewayProcess.status = 'error'
      gatewayProcess.errorMessage = error.message
      this.emit('error', { botId, error })
    })

    process.on('exit', (code, signal) => {
      gatewayProcess.status = 'stopped'
      this.processes.delete(botId)
      this.emit('stopped', { botId, code, signal })
    })

    // Wait for startup with timeout
    await this.waitForStartup(botId, 30000)
  }

  /**
   * Stop a bot gateway
   */
  async stopBot(botId: string): Promise<void> {
    const gatewayProcess = this.processes.get(botId)
    if (!gatewayProcess) {
      throw new Error(`Bot ${botId} is not running`)
    }

    gatewayProcess.status = 'stopping'

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown fails
        gatewayProcess.process.kill('SIGKILL')
        reject(new Error(`Bot ${botId} did not stop gracefully`))
      }, 10000)

      gatewayProcess.process.once('exit', () => {
        clearTimeout(timeout)
        this.processes.delete(botId)
        this.portAllocation.delete(botId)
        resolve()
      })

      // Send SIGTERM for graceful shutdown
      gatewayProcess.process.kill('SIGTERM')
    })
  }

  /**
   * Restart a bot gateway
   */
  async restartBot(bot: Bot): Promise<void> {
    const botId = typeof bot === 'string' ? bot : bot.agentId

    try {
      await this.stopBot(botId)
    } catch (error) {
      // Bot might not be running, continue anyway
    }

    await this.startBot(bot)
  }

  /**
   * Get status of a bot gateway
   */
  getStatus(botId: string): GatewayProcess | undefined {
    return this.processes.get(botId)
  }

  /**
   * Get all running processes
   */
  getAllProcesses(): GatewayProcess[] {
    return Array.from(this.processes.values())
  }

  /**
   * Stop all bots
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.processes.keys()).map((botId) =>
      this.stopBot(botId).catch((error) => {
        this.emit('error', { botId, error })
      })
    )

    await Promise.all(stopPromises)
  }

  /**
   * Allocate a port for a bot
   */
  private allocatePort(botId: string): number {
    // Check if port already allocated
    const existing = this.portAllocation.get(botId)
    if (existing) return existing

    // Find next available port
    const usedPorts = new Set(Array.from(this.portAllocation.values()))
    let port = this.config.basePort

    while (usedPorts.has(port)) {
      port++
    }

    if (port >= this.config.basePort + this.config.maxBots) {
      throw new Error('Maximum number of bots reached')
    }

    this.portAllocation.set(botId, port)
    return port
  }

  /**
   * Get bot directory path
   */
  private getBotDirectory(botId: string): string {
    return join(this.config.basePath, 'bots', botId)
  }

  /**
   * Generate OpenClaw config file for a bot
   */
  private async generateBotConfig(bot: Bot | string, port: number): Promise<string> {
    const botData = typeof bot === 'string' ? null : bot
    const botId = typeof bot === 'string' ? bot : bot.agentId

    // Create bot directory
    const botDir = this.getBotDirectory(botId)
    await mkdir(botDir, { recursive: true })
    await mkdir(join(botDir, 'credentials'), { recursive: true })
    await mkdir(join(botDir, 'sessions'), { recursive: true })

    // Generate config
    const config = {
      meta: {
        lastTouchedVersion: '2026.1.30',
        lastTouchedAt: new Date().toISOString()
      },
      agents: {
        defaults: {
          model: botData?.model || 'claude-sonnet-4-5',
          systemPrompt: botData?.systemPrompt || undefined
        },
        list: [
          {
            agentId: botId,
            name: (typeof botData?.name === 'string' ? botData.name : botId),
            model: botData?.model || 'claude-sonnet-4-5',
            systemPrompt: botData?.systemPrompt || undefined
          }
        ]
      },
      gateway: {
        port,
        bind: botData && typeof botData.gateway === 'object' && botData.gateway !== null && 'bind' in botData.gateway
          ? botData.gateway.bind
          : 'loopback',
        auth: {
          token: botData && typeof botData.gateway === 'object' && botData.gateway !== null && 'authToken' in botData.gateway
            ? botData.gateway.authToken
            : undefined
        }
      },
      session: {
        scope: botData && typeof botData.sessions === 'object' && botData.sessions !== null && 'scope' in botData.sessions
          ? botData.sessions.scope
          : 'per-sender',
        reset: {
          mode: botData && typeof botData.sessions === 'object' && botData.sessions !== null && 'resetMode' in botData.sessions
            ? botData.sessions.resetMode
            : 'daily'
        }
      },
      tools: {
        bash: botData && typeof botData.tools === 'object' && botData.tools !== null && 'bash' in botData.tools
          ? botData.tools.bash
          : false,
        browser: botData && typeof botData.tools === 'object' && botData.tools !== null && 'browser' in botData.tools
          ? botData.tools.browser
          : false,
        media: botData && typeof botData.tools === 'object' && botData.tools !== null && 'media' in botData.tools
          ? botData.tools.media
          : true
      },
      channels: {},
      bindings: []
    }

    const configPath = join(botDir, 'config.json5')
    await writeFile(configPath, JSON.stringify(config, null, 2))

    return configPath
  }

  /**
   * Wait for gateway to start
   */
  private async waitForStartup(botId: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Bot ${botId} startup timeout`))
      }, timeout)

      const checkStatus = () => {
        const process = this.processes.get(botId)
        if (process?.status === 'running') {
          clearTimeout(timeoutId)
          this.removeListener('started', onStarted)
          this.removeListener('error', onError)
          resolve()
        }
      }

      const onStarted = (event: { botId: string }) => {
        if (event.botId === botId) {
          checkStatus()
        }
      }

      const onError = (event: { botId: string; error: Error }) => {
        if (event.botId === botId) {
          clearTimeout(timeoutId)
          this.removeListener('started', onStarted)
          this.removeListener('error', onError)
          reject(event.error)
        }
      }

      this.on('started', onStarted)
      this.on('error', onError)

      // Check immediately in case already started
      checkStatus()
    })
  }
}

// Singleton instance
let orchestrator: GatewayOrchestrator | null = null

export function getOrchestrator(): GatewayOrchestrator {
  if (!orchestrator) {
    orchestrator = new GatewayOrchestrator({
      basePath: process.env.OPENCLAW_BASE_PATH || '/var/openclaw',
      basePort: Number.parseInt(process.env.OPENCLAW_BASE_PORT || '18789', 10),
      maxBots: Number.parseInt(process.env.OPENCLAW_MAX_BOTS || '50', 10),
      openclawBinaryPath: process.env.OPENCLAW_BINARY_PATH || 'openclaw'
    })
  }

  return orchestrator
}
