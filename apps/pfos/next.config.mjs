/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: ".openclaw-next",
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.symlinks = false;
    return config;
  },
};

export default nextConfig;
