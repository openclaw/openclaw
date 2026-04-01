import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        dashboard: "0 24px 80px rgba(15, 23, 42, 0.28)",
      },
      colors: {
        claw: {
          ink: "#0f172a",
          mist: "#f7f4ef",
          reef: "#dfe9e4",
          shell: "#fffaf1",
        },
      },
      fontFamily: {
        sans: ["Segoe UI", "SF Pro Display", "Helvetica Neue", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
