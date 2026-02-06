import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow long-running API routes for agent streaming
  serverExternalPackages: [],
};

export default nextConfig;
