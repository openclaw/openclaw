import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Your custom Next.js configuration here
  experimental: {
    reactCompiler: false
  }
}

export default withPayload(nextConfig)
