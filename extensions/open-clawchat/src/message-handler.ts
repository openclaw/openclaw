/**
 * Open-ClawChat Message Handler
 * Handles incoming messages and dispatches them to the OpenClaw AI agent
 */

import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk"
import { getOpenClawChatRuntime } from "./runtime.js"
import type { ResolvedOpenClawChatAccount, OpenClawChatMessageContext } from "./types.js"
import { OpenClawChatWSClient } from "./websocket-client.js"
import { OpenClawChatAPIClient } from "./api-client.js"
import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Call AI agent directly using openclaw CLI
 */
async function callAgent(prompt: string, agentId: string = "main"): Promise<string | null> {
  return new Promise((resolve) => {
    const openclawPath = "/Users/godspeed/.npm-global/bin/openclaw"
    const tmpFile = path.join(os.tmpdir(), `openclawchat-${Date.now()}.txt`)

    fs.writeFileSync(tmpFile, prompt, "utf8")

    const shellCmd = `export HOME=/Users/godspeed NODE_TLS_REJECT_UNAUTHORIZED=0 && ${openclawPath} agent --agent ${agentId} --message "$(cat ${tmpFile})" --local --timeout 30`

    const child = spawn(shellCmd, [], {
      timeout: 35000,
      shell: "/bin/zsh"
    })

    let output = ""

    child.stdout.on("data", (data) => {
      output += data.toString()
    })

    child.stderr.on("data", (data) => {
      // Ignore stderr
    })

    child.on("close", () => {
      try { fs.unlinkSync(tmpFile) } catch {}

      // Strip ANSI color codes for filtering
      const stripAnsi = (str: string) => str.replace(/\u001b\[\d+m/g, "")

      const lines = output.split("\n").filter(line => {
        const trimmed = line.trim()
        if (!trimmed) return false
        // Strip ANSI codes before checking
        const clean = stripAnsi(trimmed)
        if (clean.startsWith("[") && clean.includes("]")) return false
        if (clean.startsWith("Config")) return false
        if (clean.includes("Config warnings")) return false
        if (clean.includes("Plugin registered")) return false
        return true
      })

      const result = lines.join("\n").trim()

      if (result === "NO_REPLY" || result === "" || result === "null") {
        resolve(null)
      } else {
        resolve(result)
      }
    })

    setTimeout(() => {
      try { fs.unlinkSync(tmpFile) } catch {}
      child.kill()
      resolve(null)
    }, 40000)
  })
}

/**
 * Handle incoming WebSocket message and dispatch to AI agent
 */
export async function handleOpenClawChatMessage(params: {
  cfg: ClawdbotConfig
  ctx: OpenClawChatMessageContext
  account: ResolvedOpenClawChatAccount
  wsClient: OpenClawChatWSClient
  apiClient: OpenClawChatAPIClient
  runtime?: RuntimeEnv
}): Promise<void> {
  const { cfg, ctx, account, wsClient, apiClient, runtime } = params

  const log = runtime?.log ?? console.log
  const error = runtime?.error ?? console.error

  log(
    `[open-clawchat][${account.accountId}] processing message from ${ctx.senderName} (${ctx.senderId}) in ${ctx.roomId}`
  )

  try {
    // Ignore bot's own messages
    if (ctx.senderName?.includes("大汪") || ctx.senderId?.includes("dawang")) {
      log(`[open-clawchat][${account.accountId}] ignoring own message`)
      return
    }

    // Build prompt
    const prompt = `你是大汪，技术大牛，资深软件架构师。说话直接有逻辑，擅长编程、系统架构、性能优化。

当前场景：OpenClawChat 聊天室 "${ctx.roomId}"

${ctx.senderName}说："${ctx.content}"

作为大汪，请直接回复这条消息。如果不想回复，输出 "NO_REPLY"。
控制在200字内，技术大牛人设。`

    log(`[open-clawchat][${account.accountId}] calling AI agent...`)

    // Call AI agent (using main agent with 大汪 identity in prompt)
    const reply = await callAgent(prompt, "main")

    if (reply) {
      log(`[open-clawchat][${account.accountId}] AI reply: ${reply.substring(0, 80)}...`)

      // Add delay for natural feel
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))

      // Send reply via WebSocket
      if (wsClient.isActive) {
        wsClient.sendMessage(reply, { replyTo: ctx.replyTo })
        log(`[open-clawchat][${account.accountId}] reply sent`)
      } else {
        // Fallback to API
        await apiClient.sendMessage(ctx.roomId, reply, ctx.replyTo)
        log(`[open-clawchat][${account.accountId}] reply sent via API`)
      }
    } else {
      log(`[open-clawchat][${account.accountId}] AI chose not to reply`)
    }
  } catch (err) {
    error(`[open-clawchat][${account.accountId}] failed to handle message: ${String(err)}`)
    if (err instanceof Error && err.stack) {
      error(`[open-clawchat][${account.accountId}] stack: ${err.stack}`)
    }
  }
}
