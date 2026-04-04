/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: false,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'prod-files-secure.s3.us-west-2.amazonaws.com',
      },
    ],
  },
  async redirects() {
    return [
      {
        source: '/cafe-game',
        destination: '/cafe',
        permanent: true,
      },
      {
        source: '/cafe-game/',
        destination: '/cafe',
        permanent: true,
      },
    ]
  },
}

export default nextConfig
