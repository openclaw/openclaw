/**
 * Remotion Studio configuration.
 *
 * Key stability features:
 * - Webpack watcher ignores large asset/output directories
 * - Prevents file-event storms from demo frames, render output, etc.
 */
import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

Config.overrideWebpackConfig((currentConfig) => {
  // Enable Tailwind
  const withTailwind = enableTailwind(currentConfig);

  return {
    ...withTailwind,
    watchOptions: {
      // Ignore large folders that cause file-watcher storms on macOS
      ignored: [
        "**/node_modules/**",
        "**/out/**",
        "**/.remotion-bundle/**",
        "**/brands/**/datasets/motion/frames/**",
        "**/brand-ai/**",
      ],
      // Use polling on macOS for stability (avoids FSEvents crashes)
      poll: 500,
    },
    // Keep other config stable — snapshot defaults are fine
  };
});
