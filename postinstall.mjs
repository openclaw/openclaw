const env = process.env;

if (process.platform === "darwin" && env.npm_config_global === "true") {
  try {
    const { runPostinstallGatewayServiceRepair } =
      await import("./dist/postinstall-gateway-service.js");
    await runPostinstallGatewayServiceRepair();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[openclaw postinstall] skipped LaunchAgent repair: ${detail}`);
  }
}
