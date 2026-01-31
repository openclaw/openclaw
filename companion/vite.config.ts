import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "../dist/companion",
    sourcemap: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ui": path.resolve(__dirname, "../ui/src/ui"),
    },
  },
})
