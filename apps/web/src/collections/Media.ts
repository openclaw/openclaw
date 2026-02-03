import type { CollectionConfig } from 'payload'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    useAsTitle: 'filename',
    defaultColumns: ['filename', 'mimeType', 'filesize', 'updatedAt']
  },
  access: {
    read: () => true
  },
  upload: {
    staticDir: 'media',
    mimeTypes: ['image/*', 'audio/*', 'video/*'],
    imageSizes: [
      {
        name: 'thumbnail',
        width: 400,
        height: 300,
        position: 'centre'
      },
      {
        name: 'card',
        width: 768,
        height: 1024,
        position: 'centre'
      }
    ],
    adminThumbnail: 'thumbnail'
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: false
    }
  ]
}
