import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";
import qrcode from "qrcode-terminal";
import { resolveDefaultTypeXAccountId } from "./client/accounts.js";
import { getTypeXClient } from "./client/client.js";

export const typexOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "typex",
  getStatus: async ({ cfg }) => {
    const accountId = resolveDefaultTypeXAccountId(cfg);
    const configured = Boolean(cfg.channels?.["typex"]?.accounts?.[accountId]?.token);

    return {
      channel: "typex",
      configured,
      statusLines: [`TypeX (${accountId}): ${configured ? "configured" : "not configured"}`],
      selectionHint: configured ? "configured" : "setup needed",
      quickstartScore: configured ? 5 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const typexCfg = (cfg.channels?.["typex"] ?? {}) as Record<string, any>;
    const client = getTypeXClient(undefined, { skipConfigCheck: true, typexCfg, prompter });
    await prompter.note(`Initializing TypeX ...\nPlease scan the QR code shortly.`, "TypeX Setup");

    try {
      const qrcodeData = await client.fetchQrcodeUrl();
      const parsedData = new URLSearchParams(qrcodeData);
      const qrcodeId = parsedData.get("qr_code_id") || "";
      console.log("\nScan this QR code with TypeX App:\n");
      qrcode.generate(qrcodeData, { small: true });

      // Polling
      await prompter.note("Waiting for scan...", "Status");

      let token: string | null = null;
      let userId: string = "";
      let attempts = 0;
      const maxAttempts = 60;

      while (!token && attempts < maxAttempts) {
        // wait for about 2 min
        await new Promise((r) => setTimeout(r, 2000));

        const loginSuccessfully = await client.checkLoginStatus(qrcodeId);

        if (loginSuccessfully) {
          token = await client.getAccessToken();
          userId = await client.getCurUserId();
          break;
        }

        attempts++;
        process.stdout.write(".");
      }

      console.log("\n");

      if (!token) {
        throw new Error("Login timed out. Please try again.");
      }

      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels["typex"]) cfg.channels["typex"] = {};
      if (!cfg.channels["typex"].accounts) cfg.channels["typex"].accounts = {};

      // save config
      cfg.channels["typex"].accounts[userId] = {
        token: token,
      };
      cfg.channels["typex"].defaultAccount = userId;

      await prompter.note("Success! TypeX linked.", "Done");
      await client.sendMessage(userId, "openclaw linked");

      return { cfg, accountId: userId };
    } catch (error) {
      await prompter.note(`Setup Failed: ${String(error)}`, "Error");
      return { cfg };
    }
  },
};
