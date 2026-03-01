import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/mabos/dashboard/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/mabos/api": {
        target: `http://localhost:${process.env.MABOS_GATEWAY_PORT ?? "19001"}`,
        headers: {
          Authorization: `Bearer ${process.env.MABOS_GATEWAY_TOKEN ?? "3b6332bd5944d42f8715090fb8ea323a5a691ed4b9a71641"}`,
        },
      },
    },
  },
});
