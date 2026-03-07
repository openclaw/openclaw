import React from 'react'

type Media = { path: string, mime?: string, name?: string }

function isImage(m?: string, path?: string) {
  return (m && m.startsWith('image/')) || (path && path.match(/\.(png|jpe?g|webp|gif)$/i))
}

export function MessageMedia({ media }: { media: Media[] }) {
  if (!media?.length) return null
  return (
    <div className="message-media">
      {media.map((m, i) => (
        <div key={i} className="media-item">
          {isImage(m.mime, m.path) ? (
            // MEDIA:/absolute/path should be proxied/served by the gateway; adjust URL transformation accordingly
            <img src={m.path.replace(/^MEDIA:/, '/media/')} alt={m.name || 'image'} />
          ) : (
            <a href={m.path.replace(/^MEDIA:/, '/media/')} target="_blank" rel="noreferrer">{m.name || 'file'}</a>
          )}
        </div>
      ))}
    </div>
  )
}
