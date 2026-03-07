// Draft implementation for Gateway media upload (Fastify-style)
// Adjust to the actual server framework (Fastify/Express) used by clawdbot gateway.

import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Pseudo helpers – replace with gateway's real config/log/auth utilities
const CONFIG = {
  uploads: {
    maxItemBytes: 25 * 1024 * 1024,
    accept: [ 'image/', 'application/pdf', 'text/plain', 'application/zip' ],
  },
  mediaDir: path.resolve(process.env.CLAWDBOT_MEDIA_DIR || path.join(process.env.HOME || process.cwd(), '.clawdbot', 'media', 'inbound')),
}

function ensureDir(p: string) {
  return fs.mkdir(p, { recursive: true })
}

function inferExt(mime: string, name?: string) {
  const fromName = name && path.extname(name)
  if (fromName) return fromName
  if (mime.startsWith('image/')) return '.png'
  if (mime === 'application/pdf') return '.pdf'
  return ''
}

function allowed(mime: string) {
  return CONFIG.uploads.accept.some(a => a.endsWith('/*') ? mime.startsWith(a.slice(0, -1)) : mime === a)
}

export async function registerMediaUploadRoute(fastify: any) {
  await ensureDir(CONFIG.mediaDir)

  fastify.register(import('@fastify/multipart'), { limits: { fileSize: CONFIG.uploads.maxItemBytes } })

  fastify.post('/api/media/upload', async (req: any, reply: any) => {
    const mp = await req.parts()
    const files: any[] = []

    for await (const part of mp) {
      if (part.type !== 'file') continue
      const { filename, mimetype } = part
      if (!allowed(mimetype)) {
        await part.file?.resume()
        return reply.code(415).send({ error: 'unsupported_type', mimetype })
      }
      const id = randomUUID()
      const ext = inferExt(mimetype, filename)
      const outPath = path.join(CONFIG.mediaDir, `${id}${ext}`)
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of part.file) {
        size += chunk.length
        if (size > CONFIG.uploads.maxItemBytes) {
          return reply.code(413).send({ error: 'file_too_large' })
        }
        chunks.push(chunk)
      }
      const buf = Buffer.concat(chunks)
      await fs.writeFile(outPath, buf)
      const mediaPath = `MEDIA:${outPath}`
      files.push({ path: mediaPath, mime: mimetype, name: filename, size })
    }

    return reply.send({ files })
  })
}
