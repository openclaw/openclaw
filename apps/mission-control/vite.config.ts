import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'
import os from 'os'

const OPENCLAW_DIR = resolve(os.homedir(), '.openclaw')

function openclawApiPlugin() {
  return {
    name: 'openclaw-api',
    configureServer(server: any) {
      server.middlewares.use('/api/openclaw', (req: any, res: any) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        try {
          const url = new URL(req.url, 'http://localhost')
          const path = url.pathname

          if (path === '/config') {
            const cfg = fs.readFileSync(resolve(OPENCLAW_DIR, 'openclaw.json'), 'utf8')
            res.end(cfg)
          } else if (path === '/skills') {
            const skillsDir = resolve(OPENCLAW_DIR, 'skills')
            const skills = fs.existsSync(skillsDir)
              ? fs.readdirSync(skillsDir).filter(f => {
                  try { return fs.statSync(resolve(skillsDir, f)).isDirectory() } catch { return false }
                })
              : []
            const result = skills.map(name => {
              const skillDir = resolve(skillsDir, name)
              let meta: any = { name }
              try {
                const pkg = JSON.parse(fs.readFileSync(resolve(skillDir, 'package.json'), 'utf8'))
                meta.version = pkg.version
                meta.description = pkg.description
              } catch {}
              return meta
            })
            res.end(JSON.stringify(result))
          } else if (path === '/heartbeat') {
            const hbPath = resolve(OPENCLAW_DIR, 'workspace', 'HEARTBEAT.md')
            const content = fs.existsSync(hbPath) ? fs.readFileSync(hbPath, 'utf8') : null
            res.end(JSON.stringify({ content }))
          } else if (path === '/workspace-files') {
            const wsDir = resolve(OPENCLAW_DIR, 'workspace')
            const files: any = {}
            if (fs.existsSync(wsDir)) {
              for (const f of ['IDENTITY.md', 'USER.md', 'SOUL.md', 'TOOLS.md', 'MEMORY.md']) {
                const fp = resolve(wsDir, f)
                files[f] = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null
              }
              const memDir = resolve(wsDir, 'memory')
              if (fs.existsSync(memDir)) {
                const memFiles = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 30)
                files['memory'] = memFiles.map(f => ({
                  date: f.replace('.md', ''),
                  content: fs.readFileSync(resolve(memDir, f), 'utf8')
                }))
              }
            }
            res.end(JSON.stringify(files))
          } else if (path === '/logs') {
            const logsDir = resolve(OPENCLAW_DIR, 'logs')
            let lines: string[] = []
            if (fs.existsSync(logsDir)) {
              const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort().reverse().slice(0, 3)
              for (const f of logFiles) {
                const content = fs.readFileSync(resolve(logsDir, f), 'utf8')
                lines = lines.concat(content.split('\n').filter(Boolean))
              }
            }
            res.end(JSON.stringify({ lines: lines.slice(-200) }))
          } else if (path === '/gateway-health') {
            // Check if gateway port is open
            import('net').then(({ createConnection }) => {
              const sock = createConnection(18789, '127.0.0.1')
              sock.setTimeout(1000)
              sock.on('connect', () => { sock.destroy(); res.end(JSON.stringify({ online: true, port: 18789 })) })
              sock.on('error', () => res.end(JSON.stringify({ online: false, port: 18789 })))
              sock.on('timeout', () => { sock.destroy(); res.end(JSON.stringify({ online: false, port: 18789 })) })
            })
            return
          } else {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'Not found' }))
          }
        } catch (e: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), openclawApiPlugin()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }
  },
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
    strictPort: false,
    host: true,
  }
})
